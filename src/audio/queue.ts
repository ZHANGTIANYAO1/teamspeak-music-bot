export enum PlayMode {
  Sequential = "seq",
  Loop = "loop",
  Random = "random",
  RandomLoop = "rloop",
}

export interface QueuedSong {
  id: string;
  name: string;
  artist: string;
  album: string;
  platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify";
  url?: string; // resolved lazily at play time
  coverUrl: string;
  duration: number; // seconds
  requestedBy?: string;
}

export class PlayQueue {
  private songs: QueuedSong[] = [];
  private currentIndex = -1;
  private mode: PlayMode = PlayMode.Sequential;
  private playedIndices = new Set<number>();
  private history: number[] = [];
  private forwardStack: number[] = [];
  private static readonly HISTORY_LIMIT = 50;

  private pushHistory(idx: number): void {
    if (idx < 0 || idx >= this.songs.length) return;
    this.history.push(idx);
    if (this.history.length > PlayQueue.HISTORY_LIMIT) {
      this.history.shift();
    }
  }

  add(song: QueuedSong): void {
    this.songs.push(song);
  }

  addMany(songs: QueuedSong[]): void {
    this.songs.push(...songs);
  }

  /**
   * Insert a song to play immediately after the current one. Falls
   * through to plain push when nothing is playing yet (currentIndex < 0
   * or queue empty), so the existing "add → idle bot starts playing"
   * flow continues to work.
   *
   * Shifts playedIndices and history entries > currentIndex by +1 so
   * their references stay valid after the splice.
   */
  addNext(song: QueuedSong): void {
    if (this.currentIndex < 0 || this.songs.length === 0) {
      this.songs.push(song);
      return;
    }
    const insertAt = this.currentIndex + 1;
    this.songs.splice(insertAt, 0, song);

    const shifted = new Set<number>();
    for (const i of this.playedIndices) {
      shifted.add(i > this.currentIndex ? i + 1 : i);
    }
    this.playedIndices = shifted;

    this.history = this.history.map((i) =>
      i > this.currentIndex ? i + 1 : i,
    );
  }

  remove(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    const [removed] = this.songs.splice(index, 1);

    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.currentIndex--;
    }

    // Rebuild playedIndices to account for shifted indices
    const newPlayed = new Set<number>();
    for (const idx of this.playedIndices) {
      if (idx === index) continue;
      newPlayed.add(idx > index ? idx - 1 : idx);
    }
    this.playedIndices = newPlayed;

    // Same shift logic for history — drop entries pointing at the
    // removed song; shift entries > index down by 1.
    this.history = this.history
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx));

    return removed;
  }

  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
  }

  play(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    this.currentIndex = 0;
    this.playedIndices.add(0);
    return this.songs[0];
  }

  playAt(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.pushHistory(this.currentIndex);
    // Reset the Random-mode "unplayed" pool — explicit picks restart
    // shuffle from this point. History tracking is independent and
    // unaffected by this clear.
    this.playedIndices.clear();
    this.forwardStack = [];
    this.currentIndex = index;
    this.playedIndices.add(index);
    return this.songs[index];
  }

  next(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    switch (this.mode) {
      case PlayMode.Sequential: {
        const nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.songs.length) return null;
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.Loop: {
        this.pushHistory(this.currentIndex);
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.songs[this.currentIndex];
      }
      case PlayMode.Random:
      case PlayMode.RandomLoop: {
        // 优先回到前进栈记录的位置（prev 退回的歌）
        if (this.forwardStack.length > 0) {
          const target = this.forwardStack.pop()!;
          if (target !== this.currentIndex) {
            this.pushHistory(this.currentIndex);
            this.currentIndex = target;
            this.playedIndices.add(target);
            return this.songs[target];
          }
        }

        // Shuffle bag: pick uniformly from the songs not yet played this
        // cycle, so every song plays once before any repeats (NetEase/QQ
        // style). Songs added mid-cycle aren't in playedIndices, so they're
        // naturally eligible within the current cycle.
        const unplayed: number[] = [];
        for (let i = 0; i < this.songs.length; i++) {
          if (!this.playedIndices.has(i)) unplayed.push(i);
        }

        if (unplayed.length === 0) {
          // Cycle complete.
          if (this.mode === PlayMode.Random) return null; // 随机：播完即停
          // 随机循环：reshuffle and keep going forever.
          if (this.songs.length === 1) {
            this.pushHistory(this.currentIndex);
            this.currentIndex = 0;
            this.playedIndices = new Set([0]);
            return this.songs[0];
          }
          // Start a fresh cycle: every song is eligible again, but exclude
          // the song that just played from THIS pick only, so it doesn't
          // repeat back-to-back across the boundary. It stays eligible for
          // the rest of the new cycle, so every song still plays exactly once.
          this.playedIndices = new Set();
          for (let i = 0; i < this.songs.length; i++) {
            if (i !== this.currentIndex) unplayed.push(i);
          }
        }

        const nextIndex =
          unplayed[Math.floor(Math.random() * unplayed.length)];
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        this.playedIndices.add(nextIndex);
        return this.songs[nextIndex];
      }
    }
  }

  prev(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    // 记录当前位置到前进栈，供 next 优先返回
    if (this.currentIndex >= 0 && this.forwardStack.length < PlayQueue.HISTORY_LIMIT) {
      this.forwardStack.push(this.currentIndex);
    }

    // Preferred: pop from the back-stack so prev means "the song I
    // actually played before this one," not "the previous array slot."
    while (this.history.length > 0) {
      const idx = this.history.pop()!;
      if (idx >= 0 && idx < this.songs.length) {
        this.currentIndex = idx;
        this.playedIndices = new Set([...this.history, this.currentIndex]);
        return this.songs[idx];
      }
      // Stale entry (song removed) — keep popping.
    }

    // Fallback: no history to walk back through. In Sequential we
    // can still meaningfully step the index backward; in random
    // modes there's nothing useful to return.
    if (this.mode === PlayMode.Random || this.mode === PlayMode.RandomLoop) {
      return null;
    }
    const prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      if (this.mode === PlayMode.Sequential) return null;
      this.currentIndex = this.songs.length - 1;
    } else {
      this.currentIndex = prevIndex;
    }
    this.playedIndices.add(this.currentIndex);
    return this.songs[this.currentIndex];
  }

  current(): QueuedSong | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.songs.length)
      return null;
    return this.songs[this.currentIndex];
  }

  list(): QueuedSong[] {
    return [...this.songs];
  }

  size(): number {
    return this.songs.length;
  }

  isEmpty(): boolean {
    return this.songs.length === 0;
  }

  getMode(): PlayMode {
    return this.mode;
  }

  setMode(mode: PlayMode): void {
    this.mode = mode;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    if (this.currentIndex >= 0) {
      this.playedIndices.add(this.currentIndex);
    }
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /** Number of songs not yet played in Random mode. */
  unplayedCount(): number {
    return this.songs.length - this.playedIndices.size;
  }
}
