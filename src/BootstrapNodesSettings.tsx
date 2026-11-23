import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@kaigen/platform";
import type { Language } from "./i18n";

type NodeStatus = "unknown" | "used" | "reachable" | "unreachable";
type NodeAddress = { host: string; port: number; publicKey: string };
type BootstrapNode = NodeAddress & { status: NodeStatus };
type NodeRow = Omit<BootstrapNode, "port"> & {
  id: number;
  port: string;
  revision: number;
  probeStatus?: "reachable" | "unreachable";
  testing?: boolean;
  testError?: boolean;
};

const statusLabel: Record<NodeStatus, readonly [string, string]> = {
  unknown: ["Не проверена", "Not checked"],
  used: ["Использована", "Used"],
  reachable: ["Доступна", "Reachable"],
  unreachable: ["Недоступна", "Unreachable"],
};

function nodeAddress(row: NodeRow): NodeAddress | null {
  const host = row.host.trim();
  const port = Number(row.port);
  const publicKey = row.publicKey.trim().toUpperCase();
  if (!host || /\s/u.test(host) || !/^\d+$/u.test(row.port)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !/^[0-9A-F]{64}$/u.test(publicKey)) return null;
  return { host, port, publicKey };
}

function sameNode(row: NodeRow, node: NodeAddress) {
  const address = nodeAddress(row);
  return address?.host.toLowerCase() === node.host.toLowerCase()
    && address.port === node.port && address.publicKey === node.publicKey.toUpperCase();
}

function nodeStatus(status: NodeStatus): NodeStatus {
  return status === "used" || status === "reachable" || status === "unreachable" ? status : "unknown";
}

export default function BootstrapNodesSettings({ active, language }: { active: boolean; language: Language }) {
  const titleId = useId();
  const [rows, setRows] = useState<NodeRow[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [reload, setReload] = useState(0);
  const id = useRef(0);
  const generation = useRef(0);
  const readRevision = useRef(0);
  const probes = useRef(new Map<number, number>());
  const saveInProgress = useRef(false);
  const local = (ru: string, en: string) => language === "ru" ? ru : en;

  useEffect(() => () => {
    generation.current += 1;
  }, []);

  function acceptNodes(nodes: BootstrapNode[], isCurrent = () => true) {
    const loaded = nodes.map((node) => ({
      ...node, port: String(node.port), status: nodeStatus(node.status), id: ++id.current, revision: 0,
    }));
    setRows((current) => !isCurrent() ? current : loaded.map((row, index) => {
      const previous = current?.find((item) => sameNode(item, nodes[index]));
      return previous ? {
        ...row, id: previous.id, revision: previous.revision,
        probeStatus: previous.probeStatus, testError: previous.testError,
      } : row;
    }));
  }

  useEffect(() => {
    if (!active || dirty || saving) return;
    let disposed = false;
    let reading = false;
    const load = async () => {
      if (reading || probes.current.size || saveInProgress.current) return;
      reading = true;
      const revision = readRevision.current;
      try {
        const nodes = await invoke<BootstrapNode[]>("get_tox_bootstrap_nodes");
        if (disposed || revision !== readRevision.current) return;
        const isCurrent = () => !disposed && revision === readRevision.current;
        acceptNodes(nodes, isCurrent);
        setError((previous) => isCurrent() ? null : previous);
      } catch {
        if (!disposed) setError((previous) => !disposed && revision === readRevision.current ? "load" : previous);
      } finally {
        reading = false;
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [active, dirty, reload, saving]);

  function editRows(update: (current: NodeRow[]) => NodeRow[]) {
    readRevision.current += 1;
    setError(null);
    setDirty(true);
    setRows((current) => current && update(current));
  }

  function editNode(row: NodeRow, field: "host" | "port" | "publicKey", value: string) {
    probes.current.delete(row.id);
    editRows((current) => current.map((item) => item.id === row.id
      ? { ...item, [field]: value, status: "unknown", revision: item.revision + 1, probeStatus: undefined, testing: false, testError: false }
      : item));
  }

  async function testNode(row: NodeRow) {
    const node = nodeAddress(row);
    if (!active || !node || saveInProgress.current || probes.current.has(row.id)) return;
    const owner = generation.current;
    const request = ++readRevision.current;
    probes.current.set(row.id, request);
    const update = (patch: Partial<NodeRow>) => setRows((current) => current && current.map((item) =>
      item.id === row.id && item.revision === row.revision ? { ...item, ...patch } : item));
    update({ testing: true, testError: false });
    let result: Partial<NodeRow>;
    try {
      const status = await invoke<NodeStatus>("test_tox_bootstrap_node", { node });
      if (status !== "reachable" && status !== "unreachable") throw new Error("BOOTSTRAP_PROBE_RESULT_INVALID");
      result = { testing: false, probeStatus: status, testError: false };
    } catch {
      result = { testing: false, probeStatus: undefined, testError: true };
    }
    if (generation.current === owner && probes.current.get(row.id) === request) {
      probes.current.delete(row.id);
      update(result);
    }
  }

  async function applyNodes() {
    if (!active || !rows || !dirty || saveInProgress.current || probes.current.size) return;
    const nodes = rows.map(nodeAddress);
    if (nodes.some((node) => !node)) return;
    const owner = generation.current;
    readRevision.current += 1;
    saveInProgress.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await invoke<BootstrapNode[]>("set_tox_bootstrap_nodes", { nodes });
      if (generation.current !== owner) return;
      acceptNodes(saved);
      setDirty(false);
    } catch {
      if (generation.current === owner) setError("save");
    } finally {
      saveInProgress.current = false;
      if (generation.current === owner) setSaving(false);
    }
  }

  const invalid = rows?.some((row) => !nodeAddress(row));
  return <section className="settings-section bootstrap-settings" aria-labelledby={titleId} data-i18n-ignore translate="no">
    <h2 id={titleId}>{local("Bootstrap-ноды", "Bootstrap nodes")}</h2>
    <p className="setting-note">{local(
      "Изменения списка применяются без переподключения к сети Tox.",
      "List changes apply without reconnecting to the Tox network.",
    )}</p>
    {rows === null && error === null && <p className="bootstrap-settings-message" role="status">{local("Загрузка списка…", "Loading nodes…")}</p>}
    {error && <p className="setting-error" role="alert">{error === "save"
      ? local("Не удалось применить список. Проверьте адреса, порты и ключи.", "Could not apply the list. Check the addresses, ports, and keys.")
      : local("Не удалось получить список нод.", "Could not load the node list.")}</p>}
    {rows === null && error === "load" && <button type="button" className="outline-button" onClick={() => setReload((value) => value + 1)}>
      {local("Повторить", "Retry")}
    </button>}
    {rows && <>
      {!rows.length && <p className="bootstrap-settings-message">{local("В списке нет нод.", "The node list is empty.")}</p>}
      {dirty && invalid && <p className="bootstrap-settings-message" role="status">{local(
        "Укажите адрес, порт от 1 до 65535 и публичный ключ из 64 шестнадцатеричных символов.",
        "Enter an address, a port from 1 to 65535, and a 64-character hexadecimal public key.",
      )}</p>}
      <ul className="bootstrap-settings-list">
        {rows.map((row, index) => {
          const number = index + 1;
          const status = row.status === "used" ? "used" : row.probeStatus ?? row.status;
          const label = statusLabel[status][language === "ru" ? 0 : 1];
          return <li key={row.id} className="bootstrap-settings-row" data-status={status}>
            <label className="setting-field bootstrap-settings-field">
              <span>{local("Адрес", "Address")}</span>
              <input aria-label={local(`Адрес ноды ${number}`, `Node ${number} address`)} type="text" autoCapitalize="off" autoComplete="off" spellCheck={false} value={row.host} disabled={saving} onChange={(event) => editNode(row, "host", event.target.value)} />
            </label>
            <label className="setting-field bootstrap-settings-field">
              <span>{local("Порт", "Port")}</span>
              <input aria-label={local(`Порт ноды ${number}`, `Node ${number} port`)} type="text" inputMode="numeric" value={row.port} disabled={saving} onChange={(event) => editNode(row, "port", event.target.value)} />
            </label>
            <label className="setting-field bootstrap-settings-field bootstrap-settings-key">
              <span>{local("Публичный ключ", "Public key")}</span>
              <input aria-label={local(`Публичный ключ ноды ${number}`, `Node ${number} public key`)} type="text" autoCapitalize="off" autoComplete="off" spellCheck={false} value={row.publicKey} disabled={saving} onChange={(event) => editNode(row, "publicKey", event.target.value)} />
            </label>
            <div className="bootstrap-settings-actions">
              <span className="bootstrap-settings-status" role="status">{row.testing ? local("Проверяется…", "Checking…")
                : row.testError && status !== "used" ? local("Ошибка проверки", "Check failed") : label}</span>
              <button type="button" className="outline-button" aria-label={local(`Проверить ноду ${number}`, `Test node ${number}`)} disabled={saving || row.testing || !nodeAddress(row)} onClick={() => void testNode(row)}>
                {local("Проверить", "Test")}
              </button>
              <button type="button" className="outline-button bootstrap-settings-remove" aria-label={local(`Удалить ноду ${number}`, `Remove node ${number}`)} disabled={saving} onClick={() => {
                probes.current.delete(row.id);
                editRows((current) => current.filter((item) => item.id !== row.id));
              }}>×</button>
            </div>
          </li>;
        })}
      </ul>
      <div className="bootstrap-settings-buttons">
        <button type="button" className="outline-button" disabled={saving} onClick={() => {
          const row: NodeRow = { id: ++id.current, revision: 0, host: "", port: "", publicKey: "", status: "unknown" };
          editRows((current) => [...current, row]);
        }}>{local("Добавить ноду", "Add node")}</button>
        <button type="button" className="save-button" disabled={!dirty || saving || invalid || rows.some((row) => row.testing)} onClick={() => void applyNodes()}>
          {saving ? local("Применение…", "Applying…") : local("Применить список", "Apply list")}
        </button>
      </div>
    </>}
  </section>;
}
