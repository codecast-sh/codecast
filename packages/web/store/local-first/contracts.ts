import type { CommitResult } from "./persistence/adapter";
import { LocalFirstEngine, type SourceHandle, type SourceToken } from "./engine";
import {
  asGrantKey,
  asViewKey,
  type CanonicalEntityInput,
  type CompleteViewInput,
  type ExplicitEntityRemoval,
  type ProjectionViewRowInput,
  type SourceCoverage,
} from "./types";

const COMPLETE_VIEW_CONTRACT = Symbol("complete-view-contract");
const CAPTURED_RESULT = Symbol("captured-complete-view-result");

export type CompleteViewContractResult<TRow> =
  | { contractId: string; viewKey: string; access: "unavailable"; reason?: string }
  | { contractId: string; viewKey: string; access: "unauthenticated" }
  | {
      contractId: string;
      viewKey: string;
      access: "forbidden";
      revokedGrantKeys: readonly string[];
      coverage?: SourceCoverage;
    }
  | {
      contractId: string;
      viewKey: string;
      access: "missing";
      releasedGrantKeys: readonly string[];
      removals: readonly ExplicitEntityRemoval[];
      coverage?: SourceCoverage;
    }
  | {
      contractId: string;
      viewKey: string;
      access: "granted";
      grantKeys: readonly string[];
      coverage: SourceCoverage;
      rows: readonly TRow[];
    };

type CompleteViewDefinitionBase<TId extends string, TArgs, TServerResult, TRow> = {
  id: TId;
  key(args: TArgs): string;
  decode(result: TServerResult): CompleteViewContractResult<TRow>;
};

export type CanonicalCompleteViewDefinition<
  TId extends string,
  TArgs,
  TServerResult,
  TRow,
> = CompleteViewDefinitionBase<TId, TArgs, TServerResult, TRow> & {
  storage: "canonical";
  normalize(
    row: TRow,
    context: { args: TArgs; grantKeys: readonly string[] },
  ): Omit<CanonicalEntityInput, "grantKeys"> & { grantKeys: readonly string[] };
};

export type ProjectionCompleteViewDefinition<
  TId extends string,
  TArgs,
  TServerResult,
  TRow,
> = CompleteViewDefinitionBase<TId, TArgs, TServerResult, TRow> & {
  storage: "projection";
  normalize(
    row: TRow,
    context: { args: TArgs; grantKeys: readonly string[] },
  ): Omit<ProjectionViewRowInput, "grantKeys"> & { grantKeys: readonly string[] };
};

export type CompleteViewDefinition<
  TId extends string,
  TArgs,
  TServerResult,
  TRow,
> = CanonicalCompleteViewDefinition<TId, TArgs, TServerResult, TRow> |
  ProjectionCompleteViewDefinition<TId, TArgs, TServerResult, TRow>;

export type CompleteViewContract<
  TId extends string,
  TArgs,
  TServerResult,
  TRow,
> = CompleteViewDefinition<TId, TArgs, TServerResult, TRow> & {
  readonly [COMPLETE_VIEW_CONTRACT]: true;
};

/**
 * Completeness and storage ownership are fixed by the declaration. A caller
 * selecting a projection contract cannot accidentally fabricate a canonical
 * entity version, and a canonical contract cannot omit its owner/version rule.
 */
export function defineCompleteView<
  const TId extends string,
  TArgs,
  TServerResult,
  TRow,
>(definition: CanonicalCompleteViewDefinition<TId, TArgs, TServerResult, TRow>):
  CanonicalCompleteViewDefinition<TId, TArgs, TServerResult, TRow> & {
    readonly [COMPLETE_VIEW_CONTRACT]: true;
  };
export function defineCompleteView<
  const TId extends string,
  TArgs,
  TServerResult,
  TRow,
>(definition: ProjectionCompleteViewDefinition<TId, TArgs, TServerResult, TRow>):
  ProjectionCompleteViewDefinition<TId, TArgs, TServerResult, TRow> & {
    readonly [COMPLETE_VIEW_CONTRACT]: true;
  };
export function defineCompleteView(
  definition: CompleteViewDefinition<string, unknown, unknown, unknown>,
): CompleteViewContract<string, unknown, unknown, unknown> {
  return Object.freeze({ ...definition, [COMPLETE_VIEW_CONTRACT]: true }) as
    CompleteViewContract<string, unknown, unknown, unknown>;
}

export class CompleteViewContractMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompleteViewContractMismatchError";
  }
}

export type CapturedCompleteViewResult = {
  readonly [CAPTURED_RESULT]: true;
  readonly token: SourceToken;
};

/**
 * The sole adapter from a registered, authorized server result to the branded
 * materializer input. Feature components neither select completeness nor
 * manufacture writer/source epochs.
 */
export class CompleteViewSource<TArgs, TServerResult, TRow> {
  private constructor(
    private readonly engine: LocalFirstEngine,
    private readonly contract: CompleteViewContract<string, TArgs, TServerResult, TRow>,
    private readonly args: TArgs,
    private readonly handle: SourceHandle,
    private readonly viewKey: string,
  ) {}

  static async open<TArgs, TServerResult, TRow>(
    engine: LocalFirstEngine,
    contract: CompleteViewContract<string, TArgs, TServerResult, TRow>,
    args: TArgs,
  ): Promise<CompleteViewSource<TArgs, TServerResult, TRow>> {
    const viewKey = contract.key(args);
    const handle = await engine.beginSource(viewKey, contract.id);
    return new CompleteViewSource(engine, contract, args, handle, viewKey);
  }

  /** Capture request/subscription order before asynchronous work can reorder callbacks. */
  capture(): CapturedCompleteViewResult {
    return {
      [CAPTURED_RESULT]: true,
      token: this.engine.nextSourceResult(this.handle),
    };
  }

  async apply(
    captured: CapturedCompleteViewResult,
    serverResult: TServerResult,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult | null> {
    if (!captured[CAPTURED_RESULT] ||
      captured.token.viewKey !== this.handle.viewKey ||
      captured.token.contractId !== this.handle.contractId ||
      captured.token.principalEpoch !== this.handle.principalEpoch ||
      captured.token.writerEpoch !== this.handle.writerEpoch ||
      captured.token.sourceEpoch !== this.handle.sourceEpoch) {
      throw new CompleteViewContractMismatchError("Captured result belongs to another source");
    }
    const result = this.contract.decode(serverResult);
    if (result.contractId !== this.contract.id || result.viewKey !== this.viewKey) {
      throw new CompleteViewContractMismatchError(
        "Server result does not match the registered contract/view key",
      );
    }
    if (result.access === "unavailable" || result.access === "unauthenticated") {
      return null;
    }
    const fence = {
      principalId: this.engine.principalId,
      principalEpoch: captured.token.principalEpoch,
      contractId: this.contract.id,
      writerEpoch: captured.token.writerEpoch,
      sourceEpoch: captured.token.sourceEpoch,
      sourceSequence: captured.token.sourceSequence,
      coverage: result.coverage ?? ({ kind: "none" } as const),
      viewKey: asViewKey(this.viewKey),
    };
    let input: CompleteViewInput;
    if (result.access === "forbidden") {
      input = {
        ...fence,
        storage: this.contract.storage,
        access: "forbidden",
        revokedGrantKeys: result.revokedGrantKeys.map(asGrantKey),
      };
    } else if (result.access === "missing") {
      input = {
        ...fence,
        storage: this.contract.storage,
        access: "missing",
        releasedGrantKeys: result.releasedGrantKeys.map(asGrantKey),
        removals: result.removals,
      };
    } else if (this.contract.storage === "canonical") {
      const contract = this.contract as CanonicalCompleteViewDefinition<
        string,
        TArgs,
        TServerResult,
        TRow
      >;
      input = {
        ...fence,
        storage: "canonical",
        access: "granted",
        grantKeys: result.grantKeys.map(asGrantKey),
        rows: result.rows.map((row) => {
          const normalized = contract.normalize(row, {
            args: this.args,
            grantKeys: result.grantKeys,
          });
          return { ...normalized, grantKeys: normalized.grantKeys.map(asGrantKey) };
        }),
      };
    } else {
      const contract = this.contract as ProjectionCompleteViewDefinition<
        string,
        TArgs,
        TServerResult,
        TRow
      >;
      input = {
        ...fence,
        storage: "projection",
        access: "granted",
        grantKeys: result.grantKeys.map(asGrantKey),
        rows: result.rows.map((row) => {
          const normalized = contract.normalize(row, {
            args: this.args,
            grantKeys: result.grantKeys,
          });
          return { ...normalized, grantKeys: normalized.grantKeys.map(asGrantKey) };
        }),
      };
    }
    return await this.engine.replaceView(input, publish);
  }

  close(): void {
    this.engine.invalidateSource(this.viewKey);
  }
}
