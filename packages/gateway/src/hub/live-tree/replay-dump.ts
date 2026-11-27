// Debug helper (not shipped): replays a dumped stream into a tree, reporting anomalies per event.
import { readFileSync } from "node:fs";
import { EventType, type eventWithTime } from "@mirror/protocol";
import { LiveTree } from "./live-tree";

const { events } = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  events: eventWithTime[];
};
let tree: LiveTree | null = null;
let orphans = 0;
for (let i = 0; i < events.length; i++) {
  const e = events[i]!;
  if (e.type === EventType.Meta) continue;
  if (e.type === EventType.FullSnapshot) {
    tree = LiveTree.seed(events[i - 1]!, e, { checkInvariants: true, maxOrphans: 1e9 });
    console.log(i, "seed");
    continue;
  }
  tree?.apply(e);
  const now = tree?.anomalies.orphanAdd ?? 0;
  if (now !== orphans) {
    console.log(i, "orphans", now - orphans);
    const d = e.data as {
      adds?: { parentId: number; nextId: number | null; node: { id: number } }[];
      removes?: { id: number; parentId: number }[];
    };
    console.log(
      "  adds",
      JSON.stringify(d.adds?.map((a) => [a.node.id, a.parentId, a.nextId])),
      "removes",
      JSON.stringify(d.removes?.map((r) => [r.id, r.parentId])),
    );
    orphans = now;
  }
}
