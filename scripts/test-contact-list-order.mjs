import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const ordering = await importTypeScriptModule(new URL("../src/contactListOrder.ts", import.meta.url));
let assertions = 0;
const deepEqual = (...args) => {
  assertions += 1;
  assert.deepEqual(...args);
};
const match = (...args) => {
  assertions += 1;
  assert.match(...args);
};
const contacts = [
  { id: "offline-recent", status: "offline", lastEvent: 80 },
  { id: "online-older", status: "online", lastEvent: 30 },
  { id: "away", status: "away", lastEvent: 90 },
  { id: "busy", status: "busy", lastEvent: 40 },
  { id: "online-newest", status: "online", lastEvent: 100 },
  { id: "offline-no-event", status: "offline", lastEvent: null },
];
const originalIds = contacts.map(({ id }) => id);
const ids = (order, input = contacts) => ordering.orderContacts(input, order).map(({ id }) => id);

deepEqual(ids({ mode: "activity", direction: "forward", hideOffline: false }), [
  "online-newest", "away", "offline-recent", "busy", "online-older", "offline-no-event",
]);
deepEqual(ids({ mode: "activity", direction: "reverse", hideOffline: false }), [
  "offline-no-event", "online-older", "busy", "offline-recent", "away", "online-newest",
]);
deepEqual(ids({ mode: "status", direction: "forward", hideOffline: false }), [
  "online-newest", "online-older", "away", "busy", "offline-recent", "offline-no-event",
]);
deepEqual(ids({ mode: "status", direction: "reverse", hideOffline: false }), [
  "offline-recent", "offline-no-event", "busy", "away", "online-newest", "online-older",
]);
deepEqual(ids({ mode: "status", direction: "reverse", hideOffline: true }), [
  "busy", "away", "online-newest", "online-older",
]);
deepEqual(contacts.map(({ id }) => id), originalIds, "ordering never mutates the live contact snapshot");

const equalActivity = [
  { id: "first", status: "online", lastEvent: 10 },
  { id: "second", status: "online", lastEvent: 10 },
];
deepEqual(
  ids({ mode: "status", direction: "reverse", hideOffline: false }, equalActivity),
  ["first", "second"],
  "equal status/activity values keep their source order",
);

deepEqual(ordering.toggleContactSort({ mode: "activity", direction: "forward" }, "activity"), { mode: "activity", direction: "reverse" });
deepEqual(ordering.toggleContactSort({ mode: "activity", direction: "reverse" }, "activity"), { mode: "activity", direction: "forward" });
deepEqual(ordering.toggleContactSort({ mode: "activity", direction: "reverse" }, "status"), { mode: "status", direction: "forward" });
deepEqual(ordering.toggleContactSort({ mode: "status", direction: "reverse" }, "activity"), { mode: "activity", direction: "forward" });

deepEqual(ordering.normalizeContactSort({ mode: "status", direction: "reverse" }), { mode: "status", direction: "reverse" });
deepEqual(ordering.normalizeContactSort({ mode: "unknown", direction: "sideways" }), { mode: "activity", direction: "forward" });
deepEqual(ordering.normalizeContactSort(null), { mode: "activity", direction: "forward" });

const hiddenSnapshot = [{ id: "returning", status: "offline", lastEvent: 12 }];
deepEqual(ids({ mode: "activity", direction: "forward", hideOffline: true }, hiddenSnapshot), []);
const connectedSnapshot = hiddenSnapshot.map((contact) => ({ ...contact, status: "online" }));
deepEqual(
  ids({ mode: "activity", direction: "forward", hideOffline: true }, connectedSnapshot),
  ["returning"],
  "a refreshed online status immediately makes a filtered contact visible",
);

deepEqual(
  ids({ mode: "activity", direction: "forward", hideOffline: false }, [
    { id: "existing", status: "online", lastEvent: 20, eventSequence: 20 },
    { id: "new-contact", status: "online", lastEvent: 30, eventSequence: 30 },
  ]),
  ["new-contact", "existing"],
  "adding a contact is an activity event that places it first",
);

const activitySort = { mode: "activity", direction: "forward" };
let activityHold = { contactId: null, selectedId: "A", events: { A: 10, B: 5 } };
const afterActiveEvent = [
  { id: "A", status: "online", lastEvent: 20, eventSequence: 20 },
  { id: "B", status: "online", lastEvent: 5, eventSequence: 5 },
];
activityHold = ordering.updateActivityHold(activityHold, afterActiveEvent, "A", activitySort, "A");
deepEqual(activityHold.contactId, "A", "the selected contact is held after its own activity promotes it");
deepEqual(
  ids({ ...activitySort, hideOffline: false, heldContactId: activityHold.contactId }, afterActiveEvent),
  ["A", "B"],
  "the promoted selected contact remains first while held",
);

const afterOtherEvent = [
  afterActiveEvent[0],
  { id: "B", status: "online", lastEvent: 30, eventSequence: 30 },
];
activityHold = ordering.updateActivityHold(activityHold, afterOtherEvent, "A", activitySort, "B");
deepEqual(activityHold.contactId, "A", "another contact's event cannot dislodge the selected held contact");
deepEqual(
  ids({ ...activitySort, hideOffline: false, heldContactId: activityHold.contactId }, afterOtherEvent),
  ["A", "B"],
  "contacts below the held contact retain ordinary activity order",
);

activityHold = ordering.updateActivityHold(activityHold, afterOtherEvent, "B", activitySort);
deepEqual(activityHold.contactId, null, "changing selection releases the previous active-contact hold");
deepEqual(
  ids({ ...activitySort, hideOffline: false, heldContactId: activityHold.contactId }, afterOtherEvent),
  ["B", "A"],
  "after release the newer event determines the natural top contact",
);

const [appSource, cssSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
]);
match(appSource, /data-kaigen-ui-id=\{APP_UI_IDS\.main_contacts_element_sort_activity\}/u);
match(appSource, /data-kaigen-ui-id=\{APP_UI_IDS\.main_contacts_element_sort_status\}/u);
match(appSource, /data-kaigen-ui-id=\{APP_UI_IDS\.main_contacts_element_toggle_offline\}/u);
match(appSource, /aria-pressed=\{contactSort\.mode === "activity"\}/u);
match(appSource, /aria-pressed=\{contactSort\.mode === "status"\}/u);
match(appSource, /aria-pressed=\{hideOfflineContacts\}/u);
match(appSource, /sharedLayoutState = \{ appearance, chatListWidth, profileOrder, contactSort, hideOfflineContacts \}/u);
match(appSource, /setContactSort\(normalizeContactSort\(saved\.contactSort\)\)/u);
match(appSource, /setHideOfflineContacts\(saved\.hideOfflineContacts\)/u);
match(cssSource, /\.chat-list\.compact \.search, \.chat-list\.compact \.contact-list-heading/u);

assert.equal(assertions, 33, "update the declared assertion count when contact-list coverage changes");
console.log(`contact list ordering, filtering, persistence, and responsive controls: ${assertions} assertions passed`);
