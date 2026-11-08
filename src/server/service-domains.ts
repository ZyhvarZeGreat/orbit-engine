import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, nowIso } from "./db.js";
import { isDatabaseService } from "./database-urls.js";
import { domains, services, type Domain, type Service } from "./schema.js";
import { normalizeRootDomain } from "./root-domain.js";
import { getSystemSettings } from "./system-settings.js";
import { isWorkerService } from "../shared/service-runtime.js";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generatedHostnamePattern(serviceSlug: string, rootDomain: string) {
  return new RegExp(`^${escapeRegex(serviceSlug)}(?:-\\d+)?\\.${escapeRegex(rootDomain)}$`);
}

export function isGeneratedServiceHostname(serviceSlug: string, hostname: string, rootDomainInput = getSystemSettings().rootDomain) {
  const rootDomain = normalizeRootDomain(rootDomainInput);
  if (!rootDomain) return false;

  return generatedHostnamePattern(serviceSlug, rootDomain).test(hostname);
}

/**
 * If hostname looks like `<slug>` or `<slug>-N` under some root, return that root.
 * Used to find former auto-generated hostnames after a root-domain change.
 */
export function extractGeneratedRoot(serviceSlug: string, hostname: string): string | null {
  const match = hostname
    .trim()
    .toLowerCase()
    .match(new RegExp(`^${escapeRegex(serviceSlug)}(?:-\\d+)?\\.(.+)$`));
  return match?.[1] ?? null;
}

function hostnameExists(hostname: string, exceptDomainId?: string) {
  const row = db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname)).get();
  if (!row) return false;
  if (exceptDomainId && row.id === exceptDomainId) return false;
  return true;
}

function uniqueGeneratedHostname(serviceSlug: string, rootDomain: string, exceptDomainId?: string) {
  let hostname = `${serviceSlug}.${rootDomain}`;
  let counter = 1;

  while (hostnameExists(hostname, exceptDomainId)) {
    hostname = `${serviceSlug}-${counter}.${rootDomain}`;
    counter += 1;
  }

  return hostname;
}

export function ensureDefaultDomainForService(service: Service, rootDomainInput = getSystemSettings().rootDomain) {
  const rootDomain = normalizeRootDomain(rootDomainInput);
  if (!rootDomain || isDatabaseService(service) || isWorkerService(service)) return null;

  const existingServiceDomains = db.select().from(domains).where(eq(domains.serviceId, service.id)).all();
  const existingGeneratedDomain = existingServiceDomains.find((domain) => isGeneratedServiceHostname(service.slug, domain.hostname, rootDomain));
  if (existingGeneratedDomain) return existingGeneratedDomain;

  const timestamp = nowIso();
  const domain = {
    id: nanoid(10),
    serviceId: service.id,
    hostname: uniqueGeneratedHostname(service.slug, rootDomain),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  db.insert(domains).values(domain).run();
  return domain;
}

export function ensureDefaultDomainsForExistingServices(rootDomainInput = getSystemSettings().rootDomain) {
  const rootDomain = normalizeRootDomain(rootDomainInput);
  if (!rootDomain) return [];

  const created = [];
  for (const service of db.select().from(services).all()) {
    const beforeCount = db.select().from(domains).where(eq(domains.serviceId, service.id)).all().length;
    const domain = ensureDefaultDomainForService(service, rootDomain);
    const afterCount = db.select().from(domains).where(eq(domains.serviceId, service.id)).all().length;
    if (domain && afterCount > beforeCount) {
      created.push(domain);
    }
  }

  return created;
}

export type DomainRootMigrationResult = {
  migrated: Array<{ serviceId: string; from: string; to: string }>;
  removed: Array<{ serviceId: string; hostname: string }>;
  created: Domain[];
  databaseHostnames: Array<{ serviceId: string; from: string | null; to: string | null }>;
};

/**
 * When the wildcard/root domain changes, move auto-generated service URLs
 * off the former root(s) onto the new root, then ensure every app has one.
 * Custom hostnames that do not match `<slug>[ -N ].<root>` are left alone.
 */
export function reconcileGeneratedDomainsToRootDomain(nextRootInput: string): DomainRootMigrationResult {
  const nextRoot = normalizeRootDomain(nextRootInput);
  const migrated: DomainRootMigrationResult["migrated"] = [];
  const removed: DomainRootMigrationResult["removed"] = [];
  const databaseHostnames: DomainRootMigrationResult["databaseHostnames"] = [];
  const timestamp = nowIso();

  if (!nextRoot) {
    return { migrated, removed, created: [], databaseHostnames };
  }

  for (const service of db.select().from(services).all()) {
    if (isDatabaseService(service)) {
      const current = service.databasePublicHostname?.trim().toLowerCase() || null;
      if (!current) continue;
      const generatedRoot = extractGeneratedRoot(service.slug, current);
      if (!generatedRoot || generatedRoot === nextRoot) continue;
      const nextHostname = uniqueGeneratedHostname(service.slug, nextRoot);
      db.update(services)
        .set({ databasePublicHostname: nextHostname, updatedAt: timestamp })
        .where(eq(services.id, service.id))
        .run();
      databaseHostnames.push({ serviceId: service.id, from: current, to: nextHostname });
      continue;
    }

    if (isWorkerService(service)) continue;

    const serviceDomains = db.select().from(domains).where(eq(domains.serviceId, service.id)).all();
    const onNextRoot = serviceDomains.filter((domain) => isGeneratedServiceHostname(service.slug, domain.hostname, nextRoot));
    const formerGenerated = serviceDomains.filter((domain) => {
      const root = extractGeneratedRoot(service.slug, domain.hostname);
      return Boolean(root && root !== nextRoot);
    });

    if (formerGenerated.length === 0) continue;

    // Prefer keeping one row: rename the oldest former hostname onto the new root.
    const [primary, ...extras] = [...formerGenerated].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!primary) continue;

    if (onNextRoot.length > 0) {
      for (const old of formerGenerated) {
        db.delete(domains).where(eq(domains.id, old.id)).run();
        removed.push({ serviceId: service.id, hostname: old.hostname });
      }
      continue;
    }

    const nextHostname = uniqueGeneratedHostname(service.slug, nextRoot, primary.id);
    db.update(domains)
      .set({ hostname: nextHostname, status: "pending", updatedAt: timestamp })
      .where(eq(domains.id, primary.id))
      .run();
    migrated.push({ serviceId: service.id, from: primary.hostname, to: nextHostname });

    for (const old of extras) {
      db.delete(domains).where(eq(domains.id, old.id)).run();
      removed.push({ serviceId: service.id, hostname: old.hostname });
    }
  }

  const created = ensureDefaultDomainsForExistingServices(nextRoot);
  return { migrated, removed, created, databaseHostnames };
}
