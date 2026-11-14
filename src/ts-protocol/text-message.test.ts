import { describe, it, expect } from "vitest";
import { toTS3TextMessage } from "./client.js";
import {
  asClientID,
  asServerGroupID,
  asUID,
  type TextMessageEvent,
} from "@honeybbq/teamspeak";

function makeMsg(over: Partial<TextMessageEvent> = {}): TextMessageEvent {
  return {
    invokerName: "Alice",
    invokerUID: asUID("uid-abc"),
    message: "!stop",
    invokerGroups: [asServerGroupID(6n), asServerGroupID(8n)],
    targetMode: 2,
    targetID: asClientID(0),
    invokerID: asClientID(5),
    ...over,
  };
}

describe("toTS3TextMessage", () => {
  it("maps core fields and stringifies invokerID", () => {
    const r = toTS3TextMessage(makeMsg());
    expect(r.invokerName).toBe("Alice");
    expect(r.invokerId).toBe("5");
    expect(r.invokerUid).toBe("uid-abc");
    expect(r.message).toBe("!stop");
    expect(r.targetMode).toBe(2);
  });

  it("preserves the sender's server groups", () => {
    expect(
      toTS3TextMessage(makeMsg({ invokerGroups: [asServerGroupID(6n)] })).invokerGroups,
    ).toEqual(["6"]);
  });

  it("defaults missing invokerGroups to an empty array", () => {
    const partial = {
      invokerName: "Bob",
      invokerUID: asUID("u"),
      message: "!stop",
      targetMode: 1,
      targetID: asClientID(0),
      invokerID: asClientID(7),
    } as unknown as TextMessageEvent;
    expect(toTS3TextMessage(partial).invokerGroups).toEqual([]);
  });
});
