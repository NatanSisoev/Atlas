// Snapshot undo/redo for a board's cards and strings (≤ 100 steps).
const LIMIT = 100;

export function createUndo() {
  let past = [];
  let future = [];

  const snap = (board) => JSON.stringify({ cards: board.cards, strings: board.strings });

  return {
    /** Call before mutating the board. */
    push(board) {
      const s = snap(board);
      if (past[past.length - 1] === s) return;
      past.push(s);
      if (past.length > LIMIT) past.shift();
      future = [];
    },
    undo(board) {
      if (!past.length) return false;
      future.push(snap(board));
      Object.assign(board, JSON.parse(past.pop()));
      return true;
    },
    redo(board) {
      if (!future.length) return false;
      past.push(snap(board));
      Object.assign(board, JSON.parse(future.pop()));
      return true;
    },
    reset() { past = []; future = []; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
  };
}
