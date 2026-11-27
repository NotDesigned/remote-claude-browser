/**
 * One memory budget for every tab's live tree in the process. Past it, the least recently viewed
 * background tab goes dormant: its tree and tail are dropped, and the next viewer that needs it
 * gets a page snapshot, as after a buffer overflow today, for a tab nobody is watching. A dormant
 * tab builds a tree again only when that fits with room to spare (20 %).
 */
export interface BudgetMember {
  /** What its tree, sheet edits and tail take now (estimated). */
  treeBytes(): number;
  /** Not the tab a session shows. */
  readonly background: boolean;
  /** When a session last showed it. */
  readonly lastViewedAt: number;
  readonly dormant: boolean;
  goDormant(): void;
}

export const BUDGET_HYSTERESIS = 0.8;

export class TreeBudget {
  private readonly members = new Set<BudgetMember>();

  constructor(readonly totalMaxBytes: number) {
    if (!Number.isSafeInteger(totalMaxBytes) || totalMaxBytes < 1)
      throw new RangeError("totalMaxBytes must be a positive safe integer");
  }

  register(member: BudgetMember): void {
    this.members.add(member);
  }

  unregister(member: BudgetMember): void {
    this.members.delete(member);
  }

  total(): number {
    let total = 0;
    for (const member of this.members) if (!member.dormant) total += member.treeBytes();
    return total;
  }

  /** Makes background tabs dormant, least recently viewed first, until everything fits. */
  enforce(): number {
    let total = this.total();
    if (total <= this.totalMaxBytes) return 0;
    const candidates = [...this.members]
      .filter((member) => !member.dormant && member.background)
      .sort((a, b) => a.lastViewedAt - b.lastViewedAt);
    let count = 0;
    for (const member of candidates) {
      if (total <= this.totalMaxBytes) break;
      total -= member.treeBytes();
      member.goDormant();
      count += 1;
    }
    return count;
  }

  /** Whether a tree of `bytes` may be built (again): it fits with room to spare. */
  fits(bytes: number): boolean {
    return this.total() + bytes <= this.totalMaxBytes * BUDGET_HYSTERESIS;
  }
}

let processBudget: TreeBudget | undefined;

/** The process's budget, created with the first hub that has a tree. */
export function sharedTreeBudget(totalMaxBytes: number): TreeBudget {
  processBudget ??= new TreeBudget(totalMaxBytes);
  return processBudget;
}
