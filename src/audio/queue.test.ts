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
});
