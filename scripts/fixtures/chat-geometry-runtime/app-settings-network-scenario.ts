import { geometryHoldRouteGets, geometryRouteCalls, geometryResolveRoute } from "./app-platform";

const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const result = read(); if (result !== undefined) return result; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`${label} timed out`);
}
const control = (label: string) => [...document.querySelectorAll<HTMLLabelElement>(".setting-switch")].find((item) => item.querySelector("b")?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
const port = () => document.querySelector<HTMLInputElement>('.settings-content input[type="number"]')!;
const mode = () => document.querySelector<HTMLSelectElement>(".settings-content select")!;
const apply = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-content button")].find((item) => item.textContent?.trim() === "Применить")!;
const tab = () => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Сеть Tox"]')!;
const pending = (command: string, after = -1) => geometryRouteCalls.find((call) => call.command === command && call.index > after && call.status === "pending");
async function setInput(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true })); await frames();
}
async function openNetwork() {
  document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
  const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
  [...menu.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Настройки")!.click();
  await waitFor(() => tab() ?? undefined, "Settings"); tab().click(); await frames();
}
async function useProxy() {
  mode().value = "socks5"; mode().dispatchEvent(new Event("change", { bubbles: true })); await frames();
  const host = [...document.querySelectorAll<HTMLLabelElement>(".setting-field")].find((item) => item.querySelector("span")?.textContent === "Адрес сервера")!.querySelector<HTMLInputElement>("input")!;
  await setInput(host, "127.0.0.1");
}

export async function runActualSettingsNetworkScenario() {
  let assertions = 0;
  const failures: string[] = [];
  const check = (value: unknown, label: string) => { assertions++; if (!value) failures.push(label); };
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "App");
    geometryHoldRouteGets("network"); geometryHoldRouteGets("proxy");
    const before = geometryRouteCalls.length - 1;
    await openNetwork();
    const oldNetwork = await waitFor(() => pending("get_network_settings", before), "initial network GET");
    const oldProxy = await waitFor(() => pending("get_proxy_settings", before), "initial proxy GET");
    control("Использовать UDP").click();
    const network = await waitFor(() => pending("set_network_settings"), "network SET");
    check(network.settings.udpEnabled === false && network.settings.localDiscoveryEnabled === false, "UDP disable also disables LAN discovery");
    geometryResolveRoute(network.index); await frames();
    for (const call of geometryRouteCalls.filter((item) => item.command === "get_network_settings" && item.index >= oldNetwork.index && item.index < network.index && item.status === "pending").reverse()) geometryResolveRoute(call.index);
    await frames();
    check(!control("Использовать UDP").checked && !control("Обнаруживать локальных пиров").checked, "late initial network GET cannot replace committed selection");
    await useProxy(); await setInput(port(), "1080"); apply().click();
    const proxy = await waitFor(() => pending("set_proxy_settings"), "proxy SET");
    geometryResolveRoute(proxy.index); await frames();
    for (const call of geometryRouteCalls.filter((item) => item.command === "get_proxy_settings" && item.index >= oldProxy.index && item.index < proxy.index && item.status === "pending").reverse()) geometryResolveRoute(call.index);
    await frames();
    check(mode().value === "socks5", "late initial proxy GET cannot replace committed route");

    await useProxy(); await setInput(port(), "1081"); apply().click();
    const first = await waitFor(() => pending("set_proxy_settings", proxy.index), "first proxy SET");
    await setInput(port(), "1082"); apply().click(); await frames();
    const premature = pending("set_proxy_settings", first.index);
    check(!premature, "proxy writes retain user order without concurrent SET commands");
    if (premature) { geometryResolveRoute(premature.index); await frames(); geometryResolveRoute(first.index); }
    else {
      geometryResolveRoute(first.index);
      const second = await waitFor(() => pending("set_proxy_settings", first.index), "serialized second proxy SET");
      check(second.settings.port === 1082, "latest proxy snapshot enters the backend after the earlier writer");
      geometryResolveRoute(second.index);
    }
    await frames();
    check(mode().value === "socks5" && port().value === "1082", "attempted reversed SET cannot restore the older proxy selection");

    await setInput(port(), "2000"); apply().click();
    const rejection = await waitFor(() => pending("set_proxy_settings"), "rejected proxy SET");
    geometryResolveRoute(rejection.index, "DISPOSABLE_ROUTE_REFUSAL");
    const readback = await waitFor(() => pending("get_proxy_settings", rejection.index), "proxy error readback");
    check(document.querySelector(".settings-content")?.textContent?.includes("Не удалось применить"), "proxy refusal is visible");
    await setInput(port(), "3000"); apply().click();
    const retry = await waitFor(() => pending("set_proxy_settings", readback.index), "proxy retry");
    geometryResolveRoute(retry.index); await frames(); geometryResolveRoute(readback.index); await frames();
    check(port().value === "3000", "stale error readback cannot replace newer successful proxy retry");

    control("Использовать IPv6").click();
    const netReject = await waitFor(() => pending("set_network_settings", network.index), "network refusal");
    geometryResolveRoute(netReject.index, "DISPOSABLE_NETWORK_REFUSAL");
    const netReadback = await waitFor(() => pending("get_network_settings", netReject.index), "network readback");
    check(document.querySelector(".settings-content")?.textContent?.includes("Не удалось применить"), "network refusal is visible");
    geometryResolveRoute(netReadback.index); await frames();
    check(control("Использовать IPv6").checked && !control("Использовать UDP").checked, "rejected network update reads back the persisted choices");
    control("Использовать IPv6").click();
    const acrossMount = await waitFor(() => pending("set_network_settings", netReadback.index), "network retry before remount");
    document.querySelector<HTMLButtonElement>(".chats-button")!.click(); await frames();
    check(!document.querySelector(".settings-content"), "Settings actually unmounted during pending save");
    await openNetwork();
    const earlyGet = pending("get_network_settings", acrossMount.index);
    check(!earlyGet, "remount reads wait for the pending shared writer");
    geometryResolveRoute(acrossMount.index); await frames();
    const mountedGet = earlyGet ?? await waitFor(() => pending("get_network_settings", acrossMount.index), "remounted network GET");
    await frames();
    for (const call of geometryRouteCalls.filter((item) => item.command === "get_network_settings" && item.index > acrossMount.index && item.status === "pending").reverse()) geometryResolveRoute(call.index);
    const mountedProxy = await waitFor(() => pending("get_proxy_settings", acrossMount.index), "remounted proxy GET");
    for (const call of geometryRouteCalls.filter((item) => item.command === "get_proxy_settings" && item.index > acrossMount.index && item.status === "pending").reverse()) geometryResolveRoute(call.index);
    await frames();
    const finalChoice = { ipv6: control("Использовать IPv6").checked, udp: control("Использовать UDP").checked, port: port().value, readback: mountedGet, saved: acrossMount };
    check(!finalChoice.ipv6 && !finalChoice.udp && finalChoice.port === "3000", "remount recovers the final successful shared settings: " + JSON.stringify(finalChoice));
    check(!document.querySelector(".settings-content")?.textContent?.includes("Не удалось применить"), "old unmounted rejection notices do not reappear");
    check(!geometryRouteCalls.some((call) => call.status === "pending"), "all deferred commands are drained, including StrictMode reads");
    return { ok: failures.length === 0, assertions, failures, error: failures.join("; "), boundary: "actual-RootApp-and-Settings; deferred-disposable-shared-route-platform", calls: geometryRouteCalls };
  } catch (error) { return { ok: false, assertions, failures, error: error instanceof Error ? error.stack ?? error.message : String(error), calls: geometryRouteCalls }; }
  finally { geometryHoldRouteGets("network", false); geometryHoldRouteGets("proxy", false); }
}

