import { describe, expect, it } from "vitest";
import { observeReachability } from "./recovery";

describe("network recovery transitions", () => {
  it("triggers once after a known outage becomes reachable", () => {
    const offline = observeReachability(false, { isConnected: false, isInternetReachable: false });
    expect(offline).toEqual({ wasUnavailable: true, recovered: false });

    const online = observeReachability(offline.wasUnavailable, {
      isConnected: true,
      isInternetReachable: true,
    });
    expect(online).toEqual({ wasUnavailable: false, recovered: true });
    expect(observeReachability(online.wasUnavailable, {
      isConnected: true,
      isInternetReachable: true,
    })).toEqual({ wasUnavailable: false, recovered: false });
  });

  it("treats connected without internet as unavailable", () => {
    expect(observeReachability(false, {
      isConnected: true,
      isInternetReachable: false,
    })).toEqual({ wasUnavailable: true, recovered: false });
  });

  it("does not guess when reachability is unknown", () => {
    expect(observeReachability(false, {})).toEqual({ wasUnavailable: false, recovered: false });
    expect(observeReachability(true, { isConnected: undefined, isInternetReachable: undefined }))
      .toEqual({ wasUnavailable: true, recovered: false });
  });
});
