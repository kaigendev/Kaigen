// Disposable capability switch for the approved shared clipboard regression.
import { platformCapabilities as base } from "./app-platform";
export * from "./app-contact-groups-platform";
export const platformCapabilities = { ...base, browserAuthorization: new URLSearchParams(location.search).get("product") === "web" };
