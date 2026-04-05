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
  platform: "netease" | "qq" | "bilibili" | "youtube";
  url?: string; // resolved lazily at play time
  coverUrl: string;
  duration: number; // seconds
}

export class PlayQueue {
  private songs: QueuedSong[] = [];
  private currentIndex = -1;
  private mode: PlayMode = PlayMode.Sequential;

  add(song: QueuedSong): void {
    this.songs.push(song);
  }

  addMany(songs: QueuedSong[]): void {
    this.songs.push(...songs);
  }

  remove(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    const [removed] = this.songs.splice(index, 1);

    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      if (this.currentIndex >= this.songs.length) {
        this.currentIndex = this.songs.length - 1;
      }
    }

    return removed;
  }

  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
  }

  play(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.currentIndex = 0;
    return this.songs[0];
  }

  playAt(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.currentIndex = index;
    return this.songs[index];
  }

  next(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    switch (this.mode) {
      case PlayMode.Sequential: {
        const nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.songs.length) return null;
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.Loop: {
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.songs[this.currentIndex];
      }
      case PlayMode.Random: {
        if (this.songs.length === 1) return this.songs[0];
        let nextIndex: number;
        do {
          nextIndex = Math.floor(Math.random() * this.songs.length);
        } while (nextIndex === this.currentIndex && this.songs.length > 1);
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.RandomLoop: {
        if (this.songs.length === 1) {
          this.currentIndex = 0;
          return this.songs[0];
        }
        let idx: number;
        do {
          idx = Math.floor(Math.random() * this.songs.length);
        } while (idx === this.currentIndex);
        this.currentIndex = idx;
        return this.songs[idx];
      }
    }
  }

  prev(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    const prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      // In Sequential mode, don't wrap around
      if (this.mode === PlayMode.Sequential) return null;
      this.currentIndex = this.songs.length - 1;
    } else {
      this.currentIndex = prevIndex;
    }
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
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }
}
