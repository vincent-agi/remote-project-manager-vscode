/** The part of a commit the layout needs. Commits must be ordered children-before-parents. */
export interface LayoutCommit {
  readonly hash: string;
  readonly parents: readonly string[];
}

/** Where one commit sits in the graph and which lines cross its row. */
export interface GraphRow {
  readonly hash: string;
  /** Column of the commit's node. */
  readonly lane: number;
  /** Lanes with a line arriving at the node from above (including its own lane when continued). */
  readonly incoming: readonly number[];
  /** Lanes the node's lines leave towards (one per parent that is in the list). */
  readonly outgoing: readonly number[];
  /** Lanes whose line runs straight across the row (not ending at this node). */
  readonly through: readonly number[];
}

export interface GraphLayout {
  readonly rows: readonly GraphRow[];
  /** Number of columns needed to draw every row. */
  readonly laneCount: number;
}

/**
 * Assigns each commit a column ("lane") the way `git log --graph` does.
 * `lanes[i]` holds the hash the line in column `i` is waiting for. A
 * commit takes the leftmost lane waiting for it (or a free one when it is
 * a branch tip), its first parent continues in that lane, further parents
 * (merges) take or join other lanes, and any other lane that was waiting
 * for the same commit converges into it. Parents outside the list are
 * ignored, so a filtered or truncated history simply ends those lines.
 */
export function layoutGraph(commits: readonly LayoutCommit[]): GraphLayout {
  const known = new Set(commits.map((commit) => commit.hash));
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  const freeLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) {
      return free;
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const waiting = lanes.flatMap((hash, lane) => (hash === commit.hash ? [lane] : []));
    const lane = waiting.length > 0 ? waiting[0] : freeLane();
    const incoming = waiting;
    const occupiedBefore = new Set(lanes.flatMap((hash, index) => (hash === null ? [] : [index])));

    // Every lane waiting for this commit ends here.
    for (const index of waiting) {
      lanes[index] = null;
    }

    const outgoing: number[] = [];
    commit.parents
      .filter((parent) => known.has(parent))
      .forEach((parent, position) => {
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          outgoing.push(existing);
          return;
        }
        // The first parent continues in the commit's own lane; others take a free one.
        const target = position === 0 && lanes[lane] === null ? lane : freeLane();
        lanes[target] = parent;
        outgoing.push(target);
      });

    // A lane that was occupied and was not waiting for this commit keeps its
    // line across the row, even if this commit also merges into it.
    const through = [...occupiedBefore].filter((index) => !waiting.includes(index));
    rows.push({ hash: commit.hash, lane, incoming, outgoing, through });
    laneCount = Math.max(laneCount, lanes.length);
    // Drop trailing empty lanes so the graph narrows as branches end.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
  }
  return { rows, laneCount: Math.max(laneCount, 1) };
}
