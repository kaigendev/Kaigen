export const UNGROUPED_ID = "__ungrouped__";

export type ContactGroupsState = {
  version: 1;
  enabled: boolean;
  groups: Array<{ id: string; name: string }>;
  assignments: Record<string, string>;
  order: string[];
  collapsed: string[];
};

const validId = (id: unknown): id is string => typeof id === "string" && !!id.trim() && id.trim() === id;
const publicKey = (key: unknown): string | null => typeof key === "string" && /^[a-f\d]{64}$/iu.test(key) ? key.toUpperCase() : null;
const folded = (name: string) => name.toLowerCase();
const reserved = (name: string) => ["без группы", "ungrouped"].includes(folded(name));
const initial = (): ContactGroupsState => ({ version: 1, enabled: false, groups: [], assignments: {}, order: [UNGROUPED_ID], collapsed: [] });

export function groupNameError(state: ContactGroupsState, name: string, exceptId?: string): "empty" | "reserved" | "duplicate" | null {
  if (typeof name !== "string" || !name.trim()) return "empty";
  const trimmed = name.trim();
  if (reserved(trimmed)) return "reserved";
  return state.groups.some(group => group.id !== exceptId && folded(group.name) === folded(trimmed)) ? "duplicate" : null;
}

/** Repairs persisted state without consulting a possibly incomplete live contact list. */
export function normalizeContactGroups(value: unknown): ContactGroupsState {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return initial();
  const input = value as Record<string, unknown>;
  const groups: ContactGroupsState["groups"] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of Array.isArray(input.groups) ? input.groups : []) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (!validId(id) || id === UNGROUPED_ID || ids.has(id) || typeof name !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed || reserved(trimmed) || names.has(folded(trimmed))) continue;
    groups.push({ id, name: trimmed });
    ids.add(id);
    names.add(folded(trimmed));
  }
  const assignments: Record<string, string> = {};
  if (input.assignments && typeof input.assignments === "object" && !Array.isArray(input.assignments)) {
    for (const [key, id] of Object.entries(input.assignments)) {
      const stable = publicKey(key);
      if (stable && typeof id === "string" && ids.has(id) && !Object.prototype.hasOwnProperty.call(assignments, stable)) assignments[stable] = id;
    }
  }
  const occupied = new Set(Object.values(assignments));
  const retained = groups.filter(group => occupied.has(group.id));
  const allowed = new Set([UNGROUPED_ID, ...retained.map(group => group.id)]);
  const uniqueAllowed = (list: unknown): string[] => [...new Set((Array.isArray(list) ? list : []).filter((id): id is string => typeof id === "string" && allowed.has(id)))];
  const order = uniqueAllowed(input.order);
  for (const id of allowed) if (!order.includes(id)) order.push(id);
  return { version: 1, enabled: input.enabled === true, groups: retained, assignments, order, collapsed: uniqueAllowed(input.collapsed) };
}

export function createContactGroup(state: ContactGroupsState, key: string, id: string, name: string): ContactGroupsState {
  const stable = publicKey(key);
  if (!stable || !validId(id) || id === UNGROUPED_ID || state.groups.some(group => group.id === id) || groupNameError(state, name)) return state;
  return normalizeContactGroups({ ...state, groups: [...state.groups, { id, name: name.trim() }], assignments: { ...state.assignments, [stable]: id }, order: [...state.order, id] });
}

export function renameContactGroup(state: ContactGroupsState, id: string, name: string): ContactGroupsState {
  if (id === UNGROUPED_ID || !state.groups.some(group => group.id === id) || groupNameError(state, name, id)) return state;
  const trimmed = name.trim();
  if (state.groups.find(group => group.id === id)?.name === trimmed) return state;
  return { ...state, groups: state.groups.map(group => group.id === id ? { ...group, name: trimmed } : group) };
}

export function assignContactGroup(state: ContactGroupsState, key: string, groupId: string | null): ContactGroupsState {
  const stable = publicKey(key);
  if (!stable || (groupId !== null && groupId !== UNGROUPED_ID && !state.groups.some(group => group.id === groupId))) return state;
  const target = groupId === UNGROUPED_ID ? null : groupId;
  if ((state.assignments[stable] ?? null) === target) return state;
  const assignments = { ...state.assignments };
  if (target === null) delete assignments[stable];
  else assignments[stable] = target;
  return normalizeContactGroups({ ...state, assignments });
}

export function deleteContactGroup(state: ContactGroupsState, id: string): ContactGroupsState {
  if (id === UNGROUPED_ID || !state.groups.some(group => group.id === id)) return state;
  return normalizeContactGroups({ ...state, groups: state.groups.filter(group => group.id !== id), assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, groupId]) => groupId !== id)) });
}

export function toggleContactGroup(state: ContactGroupsState, id: string): ContactGroupsState {
  if (id !== UNGROUPED_ID && !state.groups.some(group => group.id === id)) return state;
  return { ...state, collapsed: state.collapsed.includes(id) ? state.collapsed.filter(groupId => groupId !== id) : [...state.collapsed, id] };
}

/** Moves the source before the target; the system group participates in ordering. */
export function reorderContactGroup(state: ContactGroupsState, id: string, targetId: string): ContactGroupsState {
  if (id === targetId || !state.order.includes(id) || !state.order.includes(targetId)) return state;
  const order = state.order.filter(groupId => groupId !== id);
  order.splice(order.indexOf(targetId), 0, id);
  if (order.every((groupId, index) => groupId === state.order[index])) return state;
  return { ...state, order };
}

export function removeContactFromGroups(state: ContactGroupsState, key: string): ContactGroupsState {
  return assignContactGroup(state, key, null);
}
