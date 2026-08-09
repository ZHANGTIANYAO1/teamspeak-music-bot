import { describe, it, expect, beforeEach } from "vitest";
import { PlayQueue, type QueuedSong, PlayMode } from "./queue.js";

function makeSong(id: string, name: string = id): QueuedSong {
  return {
    id,
    name,
    artist: "Artist",
    album: "Album",
    platform: "netease",
    url: `https://example.com/${id}.mp3`,
    coverUrl: `https://example.com/${id}.jpg`,
    duration: 240,
  };
}

describe("PlayQueue", () => {
  let queue: PlayQueue;

  beforeEach(() => {
    queue = new PlayQueue();
  });

  it("starts empty", () => {
    expect(queue.isEmpty()).toBe(true);
    expect(queue.current()).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it("adds and retrieves songs", () => {
    queue.add(makeSong("1", "Song A"));
    queue.add(makeSong("2", "Song B"));
    expect(queue.size()).toBe(2);
    expect(queue.list()[0].name).toBe("Song A");
    expect(queue.list()[1].name).toBe("Song B");
  });

  it("plays first song when starting", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.play();
    expect(queue.current()?.id).toBe("1");
  });

  it("advances to next song in sequential mode", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.play();
    expect(queue.current()?.id).toBe("1");
    const next = queue.next();
    expect(next?.id).toBe("2");
    expect(queue.current()?.id).toBe("2");
  });

  it("returns null at end in sequential mode", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("1"));
    queue.play();
    const next = queue.next();
    expect(next).toBeNull();
  });

  it("loops in loop mode", () => {
    queue.setMode(PlayMode.Loop);
    queue.add(makeSong("1"));
    queue.play();
    const next = queue.next();
    expect(next?.id).toBe("1");
  });

  it("goes to previous song", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.play();
    queue.next();
    expect(queue.current()?.id).toBe("2");
    queue.prev();
    expect(queue.current()?.id).toBe("1");
  });

  it("removes song by index", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.remove(1);
    expect(queue.size()).toBe(2);
    expect(queue.list()[1].id).toBe("3");
  });

  it("removing a song before current shifts current index", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.playAt(2); // playing C at index 2
    queue.remove(0); // remove A (before current)
    expect(queue.current()?.id).toBe("C"); // still on C
    expect(queue.getCurrentIndex()).toBe(1);
  });

  it("removing the currently-playing song lets next() advance to the shifted song", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.add(makeSong("D"));
    queue.playAt(2); // playing C
    queue.remove(2); // remove C — D shifts into slot 2
    // Before the fix this returned null (D was silently skipped)
    expect(queue.next()?.id).toBe("D");
  });

  it("removing the only song clears the queue", () => {
    queue.add(makeSong("only"));
    queue.playAt(0);
    queue.remove(0);
    expect(queue.size()).toBe(0);
    expect(queue.current()).toBeNull();
    expect(queue.next()).toBeNull();
  });

  it("removing the last song while playing it advances to null in sequential mode", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.playAt(1); // playing B (last)
    queue.remove(1);
    expect(queue.size()).toBe(1);
    // currentIndex moved to 0, so next() should try to advance past the end
    expect(queue.next()).toBeNull();
  });

  it("clears all songs", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.clear();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.current()).toBeNull();
  });

  it("random mode returns a song", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.play();
    const next = queue.next();
    expect(next).not.toBeNull();
  });

  it("random mode with single song returns null on next", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("1"));
    queue.play();
    expect(queue.next()).toBeNull();
  });

  it("random mode plays each song exactly once then stops", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.play();
    const played = new Set<string>();
    played.add(queue.current()!.id);
    for (let i = 0; i < 3; i++) {
      const song = queue.next();
      if (!song) break;
      played.add(song.id);
    }
    // All 3 songs should have been played
    expect(played).toEqual(new Set(["A", "B", "C"]));
    // next() after all played should return null
    expect(queue.next()).toBeNull();
  });

  it("random mode: removing currently-playing song does not skip others", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.add(makeSong("D"));
    queue.play(); // plays A (index 0)
    const second = queue.next()!; // plays some song
    // Remove the currently-playing song
    const curIdx = queue.getCurrentIndex();
    queue.remove(curIdx);
    // Remaining songs (excluding A and the removed song) should all be reachable
    const played = new Set<string>();
    played.add("A"); // already played via play()
    played.add(second.id); // played and then removed
    let song = queue.next();
    while (song) {
      played.add(song.id);
      song = queue.next();
    }
    // All 4 original songs should have been played or accounted for
    expect(played).toEqual(new Set(["A", "B", "C", "D"]));
  });

  it("random mode: prev does not cause duplicate plays", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.play(); // plays A
    queue.next(); // plays B or C
    queue.prev(); // go back — this song is now marked as played
    // Exhaust remaining songs
    const ids: string[] = [];
    let song = queue.next();
    while (song) {
      ids.push(song.id);
      song = queue.next();
    }
    // No song ID should appear more than once across the entire session
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("random mode: adding song mid-playback includes the new song", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.play(); // plays A
    queue.next(); // plays B
    // Add a new song while all existing songs have been played
    queue.add(makeSong("C"));
    const song = queue.next();
    expect(song).not.toBeNull();
    expect(song!.id).toBe("C");
    // After C, should stop
    expect(queue.next()).toBeNull();
  });

  it("random mode: setMode preserves current song as played", () => {
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.play(); // plays A in sequential mode
    queue.setMode(PlayMode.Random); // switch to random — A should be marked played
    // next() should only return B, never A again
    const song = queue.next();
    expect(song?.id).toBe("B");
    expect(queue.next()).toBeNull();
  });

  it("random-loop mode never returns null", () => {
    queue.setMode(PlayMode.RandomLoop);
    queue.add(makeSong("1"));
    queue.play();
    for (let i = 0; i < 10; i++) {
      expect(queue.next()).not.toBeNull();
    }
  });

  it("playAt jumps to specific index", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.playAt(2);
    expect(queue.current()?.id).toBe("3");
  });

  describe("history-aware prev", () => {
    it("walks back through played indices in random mode", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.add(makeSong("e"));

      // Force a deterministic random sequence: a → c → e
      queue.playAt(0);
      queue.playAt(2);
      queue.playAt(4);
      expect(queue.current()?.id).toBe("e");

      // prev pops back through history: e → c → a
      expect(queue.prev()?.id).toBe("c");
      expect(queue.prev()?.id).toBe("a");
    });

    it("returns null when history is empty in random mode", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.playAt(0);
      // No further moves → history is empty (only 'a' is current, never pushed)
      expect(queue.prev()).toBeNull();
    });

    it("preserves sequential prev when history is empty", () => {
      queue.setMode(PlayMode.Sequential);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.play();
      queue.next(); // currentIndex = 1
      // Sequential next() pushed 0 to history → prev pops back to 0
      expect(queue.prev()?.id).toBe("a");
    });

    it("clears history on play()", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.playAt(0);
      queue.playAt(1);
      queue.play(); // resets to index 0 and clears history
      expect(queue.prev()).toBeNull();
    });

    it("clears history on clear()", () => {
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.play();
      queue.next();
      queue.clear();
      queue.add(makeSong("c"));
      queue.play();
      // History was wiped — no prev path available beyond index 0
      expect(queue.prev()).toBeNull();
    });

    it("clears history on setMode()", () => {
      queue.setMode(PlayMode.Sequential);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.play();
      queue.next();
      // Mode change resets context
      queue.setMode(PlayMode.Random);
      expect(queue.prev()).toBeNull();
    });

    it("drops history entries pointing at a removed song", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.playAt(0);
      queue.playAt(1); // history: [0]
      queue.playAt(2); // history: [0, 1]
      // Remove song at index 1 → history entry 1 dropped
      queue.remove(1);
      // queue is now [a, c], history should be [0]
      // current was at 2 → after remove shifts to 1 → song "c"
      expect(queue.current()?.id).toBe("c");
      expect(queue.prev()?.id).toBe("a");
    });

    it("does not push to history on prev itself", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.playAt(0);
      queue.playAt(1);
      queue.playAt(2); // history: [0, 1]
      queue.prev();    // pops 1, history: [0]
      queue.prev();    // pops 0, history: []
      expect(queue.prev()).toBeNull(); // no fallback target in random mode
    });

    it("caps history at HISTORY_LIMIT (50) entries, dropping oldest", () => {
      queue.setMode(PlayMode.Random);
      // Build a queue large enough to overflow HISTORY_LIMIT
      for (let i = 0; i < 60; i++) queue.add(makeSong(`s${i}`));
      // Walk through 60 explicit picks → 59 pushes to history
      // (playAt pushes the previous currentIndex; first call has -1
      // which pushHistory rejects). After 60 playAts, history holds
      // the last 50 of those 59 entries.
      for (let i = 0; i < 60; i++) queue.playAt(i);

      // Walk back through history. The first prev returns whatever the
      // 50th-most-recent push was (= index 9, since pushes 0..58 happened
      // and the oldest 9 fell off). We can verify by counting prevs that
      // succeed before history exhausts and prev returns null in random.
      let count = 0;
      while (queue.prev() !== null) {
        count++;
        if (count > 100) break; // safety
      }
      expect(count).toBe(50);
    });
  });

  describe("addNext", () => {
    it("appends when queue is empty (no current)", () => {
      queue.addNext(makeSong("a"));
      expect(queue.size()).toBe(1);
      expect(queue.list()[0].id).toBe("a");
    });

    it("appends when nothing is currently playing (currentIndex < 0)", () => {
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      // No play() yet → currentIndex still -1
      queue.addNext(makeSong("c"));
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "c"]);
    });

    it("inserts at currentIndex+1 mid-queue", () => {
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.play();      // current = 0 (a)
      queue.next();      // current = 1 (b)
      queue.addNext(makeSong("x"));
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "x", "c", "d"]);
      expect(queue.current()?.id).toBe("b"); // current unchanged
    });

    it("makes the inserted song play next when next() is called", () => {
      queue.setMode(PlayMode.Sequential);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.play();      // current = 0 (a)
      queue.addNext(makeSong("x"));
      expect(queue.next()?.id).toBe("x");
    });

    it("shifts playedIndices entries > currentIndex by +1", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.playAt(2); // current = 2 (c), played = {2}
      queue.playAt(3); // current = 3 (d), played = {2, 3}
      queue.playAt(2); // current = 2 (c), played = {2, 3}
      // Now insert after c — d's index 3 should become 4
      queue.addNext(makeSong("x"));
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "c", "x", "d"]);
      // After addNext: currentIndex still 2; played should be {2, 4}
      // (the previously-played 'd' is now at index 4)
      // Verify by removing 'x' (index 3) — d should remain played at index 3
      queue.remove(3);
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("shifts history entries > currentIndex by +1", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.playAt(0); // current = 0
      queue.playAt(3); // current = 3 (d), history = [0]
      queue.playAt(1); // current = 1 (b), history = [0, 3]
      queue.addNext(makeSong("x"));
      // Insert at index 2 → entries > 1 shift +1 → history becomes [0, 4]
      // queue: [a, b, x, c, d]; d is now at index 4
      // prev → pop 4 → song at index 4 = d
      expect(queue.prev()?.id).toBe("d");
      // prev again → pop 0 → song at index 0 = a
      expect(queue.prev()?.id).toBe("a");
    });

    it("idle player + stale currentIndex: insertion target is currentIndex+1, not size-1", () => {
      // Reproduces the scenario where the player has gone idle but the
      // queue still has a non-negative currentIndex (e.g., after natural
      // track end without queue.clear()).
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.play();      // current = 0 (a)
      queue.next();      // current = 1 (b)
      // Simulate idle-with-stale-currentIndex: the player has gone idle
      // but queue still points at b.
      // Caller pre-captures insertedAt:
      const insertedAt = queue.getCurrentIndex() + 1; // = 2
      queue.addNext(makeSong("x"));
      // queue is now [a, b, x, c, d]
      // size-1 would be 4 (d) — WRONG.
      // insertedAt is 2 (x) — RIGHT.
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "x", "c", "d"]);
      expect(queue.size() - 1).toBe(4); // proves size-1 strategy would pick d
      const promoted = queue.playAt(insertedAt);
      expect(promoted?.id).toBe("x");
    });
  });

  // Issue #70: 随机循环 (rloop) used true random-with-replacement, so some
  // songs repeated often while others were starved. It should behave like a
  // shuffle bag (NetEase/QQ style): play every song once per cycle in random
  // order, then reshuffle and continue, avoiding an immediate cross-cycle repeat.
  describe("random-loop shuffle bag (issue #70)", () => {
    it("plays every song exactly once per cycle before repeating", () => {
      queue.setMode(PlayMode.RandomLoop);
      const N = 12;
      for (let i = 0; i < N; i++) queue.add(makeSong(`s${i}`));
      queue.play();

      const cycle1 = [queue.current()!.id];
      for (let i = 0; i < N - 1; i++) cycle1.push(queue.next()!.id);
      const cycle2: string[] = [];
      for (let i = 0; i < N; i++) cycle2.push(queue.next()!.id);

      // Each cycle is a full permutation of all N songs — zero repeats within
      // a cycle, and both cycles cover the same complete set.
      expect(new Set(cycle1).size).toBe(N);
      expect(new Set(cycle2).size).toBe(N);
      expect(new Set(cycle1)).toEqual(new Set(cycle2));
    });

    it("distributes plays evenly across songs over many cycles (no starvation)", () => {
      queue.setMode(PlayMode.RandomLoop);
      const N = 6;
      const CYCLES = 20;
      for (let i = 0; i < N; i++) queue.add(makeSong(`s${i}`));
      queue.play();

      const counts = new Map<string, number>();
      counts.set(queue.current()!.id, 1);
      for (let i = 0; i < CYCLES * N - 1; i++) {
        const id = queue.next()!.id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      // Shuffle bag => each song plays exactly CYCLES times. True random
      // would skew heavily.
      for (let i = 0; i < N; i++) {
        expect(counts.get(`s${i}`)).toBe(CYCLES);
      }
    });

    it("does not replay the same song across a cycle boundary", () => {
      queue.setMode(PlayMode.RandomLoop);
      const N = 5;
      for (let i = 0; i < N; i++) queue.add(makeSong(`s${i}`));
      queue.play();

      // Walk to the last song of cycle 1, then cross into cycle 2.
      for (let i = 0; i < N - 1; i++) queue.next();
      const lastOfCycle1 = queue.current()!.id;
      const firstOfCycle2 = queue.next()!.id;
      expect(firstOfCycle2).not.toBe(lastOfCycle1);
    });

    it("includes a song added mid-cycle within the current cycle", () => {
      queue.setMode(PlayMode.RandomLoop);
      queue.add(makeSong("A"));
      queue.add(makeSong("B"));
      queue.play(); // A
      queue.next(); // B — both originals now played this cycle
      queue.add(makeSong("C")); // added mid-cycle, still unplayed
      // C is the only unplayed song, so it must come next (not a reshuffle).
      expect(queue.next()?.id).toBe("C");
    });

    it("keeps looping forever with multiple songs (never returns null)", () => {
      queue.setMode(PlayMode.RandomLoop);
      queue.add(makeSong("A"));
      queue.add(makeSong("B"));
      queue.add(makeSong("C"));
      queue.play();
      for (let i = 0; i < 30; i++) {
        expect(queue.next()).not.toBeNull();
      }
    });
  });

  describe("snapshot / restore (#119)", () => {
    it("round-trips songs, index, and mode; strips url", () => {
      const q = new PlayQueue();
      q.add(makeSong("A"));
      q.add(makeSong("B"));
      q.setMode(PlayMode.Loop);
      q.play();
      q.next(); // current = index 1
      const snap = q.snapshot();
      expect(snap.currentIndex).toBe(1);
      expect(snap.mode).toBe(PlayMode.Loop);
      expect((snap.songs[0] as QueuedSong).url).toBeUndefined();
      expect(snap.songs.map((s) => s.id)).toEqual(["A", "B"]);

      const q2 = new PlayQueue();
      q2.restore(snap);
      expect(q2.list().map((s) => s.id)).toEqual(["A", "B"]);
      expect(q2.getCurrentIndex()).toBe(1);
      expect(q2.getMode()).toBe(PlayMode.Loop);
      expect(q2.current()?.id).toBe("B");
    });

    it("preserves requestedBy through a snapshot", () => {
      const q = new PlayQueue();
      q.add({ ...makeSong("A"), requestedBy: "alice" });
      q.play();
      const q2 = new PlayQueue();
      q2.restore(q.snapshot());
      expect(q2.current()?.requestedBy).toBe("alice");
    });

    it("degrades an out-of-range index to -1 (nothing current)", () => {
      const q = new PlayQueue();
      const { url: _url, ...noUrl } = makeSong("A");
      q.restore({ songs: [noUrl], currentIndex: 5, mode: PlayMode.Sequential });
      expect(q.getCurrentIndex()).toBe(-1);
      expect(q.current()).toBeNull();
      expect(q.list().map((s) => s.id)).toEqual(["A"]);
    });
  });

  // Issue #141: in Random/RandomLoop, next() picks from the shuffle bag and
  // ignores array order, so a song spliced in by addNext (!pn) was NOT played
  // next — it just waited for its random turn like any other song. addNext now
  // records the insert slot on the forward stack, which next() honours first.
  describe("addNext in random modes (issue #141)", () => {
    for (const mode of [PlayMode.Random, PlayMode.RandomLoop]) {
      it(`plays the inserted song next in ${mode} mode`, () => {
        queue.setMode(mode);
        for (const id of ["a", "b", "c", "d"]) queue.add(makeSong(id));
        queue.play(); // current = 0 (a)
        queue.addNext(makeSong("x"));
        expect(queue.next()?.id).toBe("x");
      });
    }

    it("plays consecutive inserts in the order the queue displays them", () => {
      queue.setMode(PlayMode.RandomLoop);
      for (const id of ["a", "b", "c", "d"]) queue.add(makeSong(id));
      queue.play(); // current = 0 (a)
      queue.addNext(makeSong("x"));
      queue.addNext(makeSong("y")); // splices in front of x, as in sequential
      expect(queue.list().map((s) => s.id)).toEqual(["a", "y", "x", "b", "c", "d"]);
      expect(queue.next()?.id).toBe("y");
      expect(queue.next()?.id).toBe("x");
    });

    it("honours the insert even after the shuffle bag is exhausted", () => {
      // Random (non-loop) returns null once every song has played. Songs added
      // afterwards must still be reachable via !pn — and with TWO of them the
      // order can only come from the forward stack, not from the bag having a
      // single remaining candidate.
      queue.setMode(PlayMode.Random);
      for (const id of ["a", "b", "c", "d"]) queue.add(makeSong(id));
      queue.play();
      for (let i = 0; i < 3; i++) queue.next();
      expect(queue.next()).toBeNull(); // bag exhausted
      queue.addNext(makeSong("x"));
      queue.addNext(makeSong("y"));
      queue.addNext(makeSong("z"));
      expect(queue.next()?.id).toBe("z");
      expect(queue.next()?.id).toBe("y");
      expect(queue.next()?.id).toBe("x");
    });

    it("pops past a prev() marker to reach the pending insert", () => {
      // prev() shares the forward stack, and in random mode with no history it
      // pushes the current index and then returns null. next() must walk past
      // those self-referencing markers instead of consuming one and giving up
      // to the shuffle bag.
      queue.setMode(PlayMode.Random);
      for (const id of ["a", "b", "c", "d"]) queue.add(makeSong(id));
      queue.play(); // a
      queue.addNext(makeSong("x"));
      expect(queue.prev()).toBeNull();
      expect(queue.prev()).toBeNull();
      expect(queue.next()?.id).toBe("x");
    });

    it("plays each song exactly once — the insert is not replayed later", () => {
      queue.setMode(PlayMode.Random);
      for (const id of ["a", "b", "c", "d"]) queue.add(makeSong(id));
      queue.play(); // a
      queue.addNext(makeSong("x"));
      queue.addNext(makeSong("y"));

      const played = [queue.current()!.id];
      for (let i = 0; i < 5; i++) played.push(queue.next()!.id);
      expect(queue.next()).toBeNull(); // bag exhausted
      expect(played.slice(0, 3)).toEqual(["a", "y", "x"]);
      expect(new Set(played).size).toBe(6);
    });

    it("keeps the insert reachable after an earlier song is removed", () => {
      queue.setMode(PlayMode.RandomLoop);
      for (const id of ["a", "b", "c", "d"]) queue.add(makeSong(id));
      queue.playAt(2); // current = 2 (c)
      queue.addNext(makeSong("x")); // [a, b, c, x, d]
      queue.remove(0); // [b, c, x, d] — x slides from 3 to 2
      expect(queue.next()?.id).toBe("x");
    });

    it("drops the entry when the inserted song is itself removed", () => {
      // Leaving the stale entry behind would not throw — index 2 still exists
      // after the removal, it just points at a different song. So the queue is
      // arranged with exactly one song the shuffle bag can legally return:
      // anything else means the dead forward entry was honoured.
      queue.setMode(PlayMode.RandomLoop);
      for (const id of ["a", "b", "c"]) queue.add(makeSong(id));
      queue.playAt(0); // current = 0 (a), played = {0}
      queue.next(); // b or c — two of the three are now played
      const remaining = queue.list().find((s) => s.id !== "a" && s.id !== queue.current()!.id)!;
      queue.addNext(makeSong("x")); // spliced at currentIndex+1
      queue.remove(queue.getCurrentIndex() + 1); // …and removed again
      expect(queue.list().map((s) => s.id)).not.toContain("x");
      expect(queue.next()?.id).toBe(remaining.id);
    });

    it("never yields a stale index under interleaved inserts and removals", () => {
      // The forward stack holds array indices, so every splice has to shift
      // them. next() returning `undefined` here (an out-of-range index) reads
      // as end-of-queue to BotInstance.playNext and silently stops playback.
      queue.setMode(PlayMode.RandomLoop);
      for (let i = 0; i < 6; i++) queue.add(makeSong(`s${i}`));
      queue.play();
      for (let step = 0; step < 200; step++) {
        const roll = step % 4;
        if (roll === 0) queue.addNext(makeSong(`x${step}`));
        else if (roll === 1 && queue.size() > 1) queue.remove(step % queue.size());
        else {
          const song = queue.next();
          expect(song === null || song === queue.current()).toBe(true);
          if (song !== null) expect(song).toBeDefined();
        }
      }
    });

    it("leaves sequential/loop behaviour untouched", () => {
      queue.setMode(PlayMode.Sequential);
      for (const id of ["a", "b", "c"]) queue.add(makeSong(id));
      queue.play(); // a
      queue.addNext(makeSong("x"));
      expect(queue.next()?.id).toBe("x");
      expect(queue.next()?.id).toBe("b");
      expect(queue.next()?.id).toBe("c");
      expect(queue.next()).toBeNull();
    });

    it("still appends (no forward entry) when nothing is playing", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.addNext(makeSong("x")); // currentIndex is still -1 → plain push
      expect(queue.list().map((s) => s.id)).toEqual(["a", "x"]);
      queue.play(); // a — a stray forward entry would have hijacked this
      expect(queue.current()?.id).toBe("a");
    });
  });
});
