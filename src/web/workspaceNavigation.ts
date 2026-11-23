export function workspaceIdentifierFromUrl(url: string) {
  const fragment = new URL(url).hash.slice(1);
  const candidate = new URLSearchParams(fragment).get("k") ?? fragment;
  return /^[A-Za-z0-9_-]{40,80}$/u.test(candidate) ? candidate : "";
}

type NavigationOptions = {
  url: string;
  readUrl: () => string;
  admit: () => void;
  start: () => void;
  prepare: () => Promise<void>;
  leave: () => Promise<void>;
  commit: (url: string) => void;
  rollback: (url: string, error: unknown, started: boolean) => void;
};

/** One document owns one workspace. A new selector retires that document. */
export class WorkspaceNavigation {
  private ownerUrl: string;
  private targetUrl: string | null = null;
  private revision = 0;
  private transition: Promise<void> | null = null;
  private documentRetired = false;

  constructor(private readonly options: NavigationOptions) {
    this.ownerUrl = options.url;
  }

  get pending() { return this.targetUrl !== null; }
  get retired() { return this.documentRetired; }

  capture() {
    const revision = this.revision;
    return () => revision === this.revision && !this.pending && this.matchesOwner(this.options.readUrl());
  }

  private matchesOwner(url: string) {
    const owner = new URL(this.ownerUrl), target = new URL(url);
    return target.origin === owner.origin && target.pathname === owner.pathname
      && (target.hash === owner.hash || (!!workspaceIdentifierFromUrl(owner.href)
        && workspaceIdentifierFromUrl(target.href) === workspaceIdentifierFromUrl(owner.href)));
  }

  // Creation and access-link rotation already own their confirmed URL change.
  adopt(url: string) {
    if (!this.pending) this.ownerUrl = url;
  }

  navigate(url: string): Promise<void> {
    if (this.pending) {
      this.targetUrl = url;
      return this.transition!;
    }
    if (this.matchesOwner(url)) {
      this.ownerUrl = url;
      return Promise.resolve();
    }
    try { this.options.admit(); }
    catch (error) {
      this.options.rollback(this.ownerUrl, error, false);
      return Promise.resolve();
    }
    this.targetUrl = url;
    this.revision += 1;
    this.options.start();
    this.transition = this.finish();
    return this.transition;
  }

  private async finish() {
    try {
      await this.options.prepare();
      await this.options.leave();
      this.documentRetired = true;
      this.options.commit(this.targetUrl!);
    } catch (error) {
      this.targetUrl = null;
      this.options.rollback(this.ownerUrl, error, true);
    }
  }
}
