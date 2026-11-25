// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialPanels, panelReducer, type PanelAction, type PanelState } from "./panels";

const run = (...actions: PanelAction[]): PanelState => actions.reduce(panelReducer, initialPanels);
const navigate = (
  destination: Extract<PanelAction, { type: "navigate" }>["destination"],
  pickerAvailable = true,
): PanelAction => ({ type: "navigate", destination, pickerAvailable });

describe("panel routing", () => {
  it("opens one workspace panel at a time", () => {
    expect(run(navigate("admin")).open).toBe("admin");
    expect(run(navigate("admin"), navigate("account")).open).toBe("account");
    expect(run(navigate("account"), navigate("mailboxes")).open).toBe("mailboxes");
    expect(run(navigate("mailboxes"), navigate("network")).open).toBe("network");
  });

  it("opens the network panel on the tab last used unless one is named", () => {
    expect(run(navigate("network"))).toMatchObject({ open: "network", networkTab: "proxies" });
    expect(run(navigate("cpa"))).toMatchObject({ open: "network", networkTab: "cpa" });
    const remoteCc = run({ type: "network-tab", tab: "remote-cc" }, navigate("network"));
    expect(remoteCc.networkTab).toBe("remote-cc");
    expect(run(navigate("cpa"), navigate("admin"), navigate("network")).networkTab).toBe("cpa");
    expect(run(navigate("proxies")).networkTab).toBe("proxies");
  });

  it("opens the profile picker only where a session can switch, closing the other panels", () => {
    expect(run(navigate("admin"), navigate("profiles"))).toEqual({
      open: null,
      networkTab: "proxies",
      pickerOpen: true,
    });
    expect(run(navigate("profiles", false)).pickerOpen).toBe(false);
    // Another destination leaves the picker as it is: the proxy manager opens over it.
    const over = run(navigate("profiles"), navigate("proxies"));
    expect(over).toMatchObject({ open: "network", networkTab: "proxies", pickerOpen: true });
  });

  it("closes only the panel that is open", () => {
    const account = run(navigate("account"));
    expect(panelReducer(account, { type: "close", panel: "admin" })).toBe(account);
    expect(panelReducer(account, { type: "close", panel: "account" }).open).toBeNull();
  });

  it("opens a panel on request, with an optional tab", () => {
    expect(run({ type: "open", panel: "network", networkTab: "remote-cc" })).toMatchObject({
      open: "network",
      networkTab: "remote-cc",
    });
    expect(run({ type: "open", panel: "account" }).open).toBe("account");
  });

  it("hands over between the network panel and the picker for a CPA authorization", () => {
    const network = run(navigate("cpa"));
    expect(panelReducer(network, { type: "browser-chosen", pickerAvailable: true })).toEqual({
      open: null,
      networkTab: "cpa",
      pickerOpen: true,
    });
    expect(
      panelReducer(network, { type: "browser-chosen", pickerAvailable: false }).pickerOpen,
    ).toBe(false);
    const picking = run(navigate("profiles"));
    expect(panelReducer(picking, { type: "picker-back", authorizationWaiting: true })).toEqual({
      open: "network",
      networkTab: "cpa",
      pickerOpen: false,
    });
    expect(panelReducer(picking, { type: "picker-back", authorizationWaiting: false })).toEqual({
      ...picking,
      pickerOpen: false,
    });
    expect(
      panelReducer(run(navigate("profiles"), navigate("network")), { type: "browser-opened" }),
    ).toMatchObject({ open: null, pickerOpen: false });
  });

  it("keeps the same state for no-op updates", () => {
    expect(panelReducer(initialPanels, { type: "picker", open: false })).toBe(initialPanels);
    expect(panelReducer(initialPanels, { type: "network-tab", tab: "proxies" })).toBe(
      initialPanels,
    );
  });
});
