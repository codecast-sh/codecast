export class VersionedObservationSet<T> extends Set<T> {
  private readonly observations = new Map<T, symbol>();

  constructor(values?: Iterable<T> | null) {
    super();
    if (values) for (const value of values) this.add(value);
  }

  override add(value: T): this {
    super.add(value);
    this.observations.set(value, Symbol());
    return this;
  }

  override delete(value: T): boolean {
    this.observations.delete(value);
    return super.delete(value);
  }

  override clear(): void {
    this.observations.clear();
    super.clear();
  }

  capture(value: T): symbol | undefined {
    return this.observations.get(value);
  }

  consume(value: T, observation: symbol | undefined): boolean {
    return observation !== undefined && this.capture(value) === observation && this.delete(value);
  }
}
