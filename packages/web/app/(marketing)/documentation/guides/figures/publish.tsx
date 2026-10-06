"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the publish guide. Versions and rollback follow
 * convex/artifacts.ts (a rollback copies the old blob into a new version);
 * gates are lib/artifactGates.ts gateFailure, checked in that order; comment
 * delivery is deliverCommentsToSession.
 */

// ─── One URL, every version ────────────────────────────────────────────────

const VERSIONS: { v: number; cmd: string; ink: Ink; body: Ink; at: number }[] = [
  { v: 1, cmd: "cast publish report.html", ink: "blue", body: "blue", at: 0.5 },
  { v: 2, cmd: "republish", ink: "green", body: "green", at: 1.4 },
  { v: 3, cmd: "republish", ink: "orange", body: "orange", at: 2.3 },
  { v: 4, cmd: "rollback 2", ink: "green", body: "green", at: 3.4 },
];
const VX = (i: number) => 40 + i * 175;

/** Republishing keeps the link and adds a version; rollback adds one too. */
export function VersionsFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={260} label="The URL stays the same. Each publish adds a version; rolling back to version 2 publishes its content again as version 4, so history stays linear">
        {(arrow) => (
          <>
            <g className="bj-pop" style={t(0.1)}>
              <rect x={230} y={16} width={300} height={30} rx={15} fill={SOL.base3} stroke={SOL.base01} strokeWidth={1.3} />
              <text x={380} y={35.5} textAnchor="middle" fontSize="12" fill={SOL.base02}>codecast.sh/a/k3x9pq</text>
            </g>
            {VERSIONS.map((v, i) => (
              <g key={v.v}>
                <path d={`M380 48C380 74 ${VX(i) + 70} 70 ${VX(i) + 70} 94`} pathLength={1} fill="none" stroke={SOL[v.ink]} strokeWidth={1.6} markerEnd={arrow(v.ink)} className="bj-draw" style={t(v.at, 0.3)} />
                {i < VERSIONS.length - 1 && (
                  <path d={`M380 48C380 74 ${VX(i) + 70} 70 ${VX(i) + 70} 94`} fill="none" stroke={SOL.base2} strokeWidth={2.4} className="bj-fade" style={t(VERSIONS[i + 1].at)} />
                )}
                <g className="bj-rise" style={t(v.at + 0.2)}>
                  <rect x={VX(i)} y={98} width={140} height={86} rx={8} fill={SOL.base3} stroke={SOL.base1} />
                  <text x={VX(i) + 12} y={118} fontSize="12" fontWeight={700} fill={SOL.base02}>v{v.v}</text>
                  <rect x={VX(i) + 12} y={128} width={116} height={7} rx={3} fill={SOL[v.body]} opacity={0.55} />
                  <rect x={VX(i) + 12} y={141} width={84} height={7} rx={3} fill={SOL[v.body]} opacity={0.3} />
                  <rect x={VX(i) + 12} y={154} width={100} height={7} rx={3} fill={SOL[v.body]} opacity={0.3} />
                  <text x={VX(i) + 70} y={204} textAnchor="middle" fontSize="10.5" fill={SOL.base01}>{v.cmd}</text>
                </g>
                {i > 0 && <path d={`M${VX(i - 1) + 142} 141H${VX(i) - 4}`} stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow()} className="bj-fade" style={t(v.at + 0.2)} />}
              </g>
            ))}
            <path d={`M${VX(1) + 70} 214C${VX(1) + 70} 236 ${VX(3) + 70} 236 ${VX(3) + 70} 214`} pathLength={1} fill="none" stroke={SOL.green} strokeDasharray="4 3" strokeWidth={1.3} markerEnd={arrow("green")} className="bj-draw" style={t(3.2, 0.4)} />
            <Label x={VX(2) + 70} y={248} lines={["v2's content, published again as v4"]} ink="green" anchor="middle" size={10} className="bj-fade" style={t(3.5)} />
            <Label x={20} y={70} lines={["?v=2 shows any version", "?diff=2..3 compares two"]} ink="base1" size={10} className="bj-fade" style={t(4.0)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Gates, in the order they are checked ──────────────────────────────────

const GATES = [
  { title: "expired?", sub: "--expires", fail: "This page has expired", ink: "base01" as Ink },
  { title: "password", sub: "--password, then ?k=", fail: "password wall", ink: "orange" as Ink },
  { title: "email", sub: "--email-gate, then ?e=", fail: "email wall", ink: "violet" as Ink },
];

/** Every request passes the gates in one order; any that is set and unmet stops it. */
export function GatesFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={220} label="A request is checked for expiry, then the password gate, then the email gate; the page opens only after all three pass">
        {(arrow) => (
          <>
            <Box x={16} y={60} w={110} h={48} title="viewer" sub="opens the link" className="bj-pop" style={t(0.1)} />
            {GATES.map((g, i) => {
              const x = 170 + i * 165;
              return (
                <g key={g.title}>
                  <path d={`M${x - 40} 84H${x - 4}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(0.3 + i * 0.6, 0.2)} />
                  <Box x={x} y={60} w={130} h={48} title={g.title} sub={g.sub} ink={g.ink} className="bj-pop" style={t(0.45 + i * 0.6)} />
                  <path d={`M${x + 65} 111V146`} pathLength={1} stroke={SOL.red} strokeWidth={1.2} strokeDasharray="3 3" fill="none" markerEnd={arrow("red")} className="bj-draw" style={t(0.6 + i * 0.6, 0.2)} />
                  <Label x={x + 65} y={164} lines={[g.fail]} anchor="middle" ink="red" size={10} className="bj-fade" style={t(0.7 + i * 0.6)} />
                </g>
              );
            })}
            <path d="M630 84H660" pathLength={1} stroke={SOL.green} strokeWidth={1.6} fill="none" markerEnd={arrow("green")} className="bj-draw" style={t(2.2, 0.2)} />
            <Box x={664} y={60} w={80} h={48} title="page" ink="green" bold={1.6} className="bj-pop" style={t(2.4)} />
            <Label x={16} y={204} lines={["A gate that is not set passes. The owner link and a signed-in account that can open the page stand behind the walls."]} ink="base1" size={10} className="bj-fade" style={t(2.8)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── The comment loop ──────────────────────────────────────────────────────

const LOOP = [
  { x: 20, y: 40, title: "viewer comments", sub: "kept on the page", ink: "magenta" as Ink },
  { x: 290, y: 40, title: "Send to session", sub: "owner link only", ink: "orange" as Ink },
  { x: 560, y: 40, title: "one message", sub: "fenced, marked untrusted", ink: "violet" as Ink },
  { x: 560, y: 170, title: "agent revises", sub: "cast publish, same URL", ink: "blue" as Ink },
  { x: 290, y: 170, title: "--resolve <id>", sub: "cast publish comments", ink: "green" as Ink },
];

/** Feedback reaches the agent only when the page's owner sends it. */
export function CommentLoopFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={260} label="Viewers comment on the page. The owner sends the comments to the session as one fenced message. The agent revises and republishes to the same URL, then resolves the comments">
        {(arrow) => (
          <>
            {LOOP.map((s, i) => (
              <Box key={s.title} x={s.x} y={s.y} w={180} h={52} title={s.title} sub={s.sub} ink={s.ink} className="bj-pop" style={t(0.2 + i * 0.6)} />
            ))}
            <path d="M203 66H286" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(0.5, 0.25)} />
            <path d="M473 66H556" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(1.1, 0.25)} />
            <path d="M650 95V166" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(1.7, 0.25)} />
            <path d="M557 196H474" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(2.3, 0.25)} />
            <path d="M287 196H110V96" pathLength={1} stroke={SOL.base1} strokeWidth={1.2} strokeDasharray="4 3" fill="none" markerEnd={arrow()} className="bj-draw" style={t(2.9, 0.4)} />
            <Label x={120} y={150} lines={["the page", "shows it resolved"]} ink="base1" size={10} className="bj-fade" style={t(3.2)} />
            <Label x={664} y={128} lines={["“left by a VIEWER", "of the link, not", "by your user”"]} ink="violet" size={10} className="bj-fade" style={t(1.9)} />
            <Label x={300} y={120} lines={["Comments posted from the owner link", "go to the session at once."]} ink="base01" size={10} className="bj-fade" style={t(3.5)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
