import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  CopyCheckIcon,
  CopyIcon,
  Delete02Icon,
  PencilEdit02Icon,
  Refresh03Icon
} from "@hugeicons/core-free-icons";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { isWildcardRootDomain, normalizeRootDomain, wildcardRootDomain } from "../../lib/root-domain";
import { AppIcon, FieldLabel, FormInput } from "../ui/primitives";
import { ConfirmationDialog } from "./confirmation-dialog";

function recordNameFor(domain: string) {
  return wildcardRootDomain(domain) || "*.your-domain.com";
}

export function RootDomainSettingsPanel({ open }: { open: boolean }) {
  const [rootDomain, setRootDomain] = useState("");
  const [savedRootDomain, setSavedRootDomain] = useState("");
  const [publicIp, setPublicIp] = useState("127.0.0.1");
  const [dnsStatus, setDnsStatus] = useState<"active" | "pending">("pending");
  const [copiedIp, setCopiedIp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [editingDomain, setEditingDomain] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const normalizedRootDomain = useMemo(() => normalizeRootDomain(rootDomain), [rootDomain]);
  const rootDomainUsesWildcard = isWildcardRootDomain(rootDomain);
  const hasSavedDomain = savedRootDomain.length > 0;
  const hasUnsavedChanges = normalizedRootDomain !== savedRootDomain;
  const wildcardHostname = recordNameFor(savedRootDomain || normalizedRootDomain);
  const waitingForDns = success.startsWith("Still waiting");

  useEffect(() => {
    if (!open) {
      setClearDialogOpen(false);
      return;
    }

    async function loadSettings() {
      setError("");
      setSuccess("");
      try {
        const res = await api.systemSettings();
        const loadedDomain = normalizeRootDomain(res.settings.rootDomain);
        setRootDomain(wildcardRootDomain(loadedDomain));
        setSavedRootDomain(loadedDomain);
        setEditingDomain(!loadedDomain);
        setInstructionsOpen(false);
        setPublicIp(res.publicIp || "127.0.0.1");
        setDnsStatus(res.dnsStatus || "pending");
      } catch (issue) {
        setError(issue instanceof Error ? issue.message : "Could not load root domain settings");
      }
    }

    void loadSettings();
  }, [open]);

  async function copyIp() {
    try {
      await navigator.clipboard.writeText(publicIp);
      setCopiedIp(true);
      setTimeout(() => setCopiedIp(false), 1500);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not copy IP address");
    }
  }

  async function refreshSettings() {
    setVerifying(true);
    setError("");
    setSuccess("");
    try {
      const res = await api.systemSettings();
      const loadedDomain = normalizeRootDomain(res.settings.rootDomain);
      const nextStatus = res.dnsStatus || "pending";
      setRootDomain(wildcardRootDomain(loadedDomain));
      setSavedRootDomain(loadedDomain);
      setDnsStatus(nextStatus);
      setPublicIp(res.publicIp || "127.0.0.1");
      setSuccess(nextStatus === "active" ? "Wildcard DNS is active." : "Still waiting on DNS.");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not verify DNS");
    } finally {
      setVerifying(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!rootDomainUsesWildcard || !normalizedRootDomain) {
      setError("Root domain must be a wildcard hostname like *.pilot.aeroplane.run.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      await api.updateSystemSettings({ rootDomain: normalizedRootDomain });
      const res = await api.systemSettings();
      const savedDomain = normalizeRootDomain(res.settings.rootDomain);
      setRootDomain(wildcardRootDomain(savedDomain));
      setSavedRootDomain(savedDomain);
      setDnsStatus(res.dnsStatus || "pending");
      setPublicIp(res.publicIp || "127.0.0.1");
      setEditingDomain(false);
      setInstructionsOpen(true);
      setSuccess("Root domain saved.");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not save root domain");
    } finally {
      setSaving(false);
    }
  }

  async function clearRootDomain() {
    setClearDialogOpen(false);
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      await api.updateSystemSettings({ rootDomain: "" });
      setRootDomain("");
      setSavedRootDomain("");
      setDnsStatus("pending");
      setEditingDomain(false);
      setInstructionsOpen(false);
      setSuccess("Root domain removed.");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not remove root domain");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="p-5 sm:p-7 lg:p-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl tracking-[-0.03em] text-white">Service domains</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
            A wildcard hostname used to generate a default URL for every service.
            Saving a new root automatically moves auto-generated app URLs off the former
            domain and rebuilds Caddy (custom domains are left unchanged). Use one DNS
            label under the apex for Cloudflare free SSL — e.g.{" "}
            <span className="font-mono text-zinc-300">*.raiserights.com</span>
            {" "}→ <span className="font-mono text-zinc-300">sofi.raiserights.com</span>
            {" "}(not <span className="font-mono text-zinc-300">sofi.app.raiserights.com</span>).
          </p>
          {hasSavedDomain && !editingDomain ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <span className="text-lg text-zinc-100">{wildcardRootDomain(savedRootDomain)}</span>
              <span className="inline-flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-500">
                <span className={`h-1.5 w-1.5 ${dnsStatus === "active" ? "bg-white" : "border border-zinc-600"}`} />
                {dnsStatus === "active" ? "DNS active" : "DNS pending"}
              </span>
            </div>
          ) : null}
        </div>

        {hasSavedDomain && !editingDomain ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center border border-white/15 text-zinc-400 transition hover:border-white/35 hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
              onClick={() => {
                setRootDomain(wildcardRootDomain(savedRootDomain));
                setEditingDomain(true);
              }}
              disabled={saving}
              title="Edit root domain"
              aria-label="Edit root domain"
            >
              <AppIcon icon={PencilEdit02Icon} size={15} />
            </button>
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center border border-white/15 text-zinc-500 transition hover:border-white/35 hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
              onClick={() => setClearDialogOpen(true)}
              disabled={saving}
              title="Delete root domain"
              aria-label="Delete root domain"
            >
              <AppIcon icon={Delete02Icon} size={15} />
            </button>
          </div>
        ) : null}
      </div>

      {!hasSavedDomain && !editingDomain ? (
        <button
          type="button"
          className="mt-6 inline-flex min-h-10 w-fit items-center justify-center bg-white px-4 text-sm text-black transition hover:bg-zinc-200"
          onClick={() => setEditingDomain(true)}
        >
          Set root domain
        </button>
      ) : null}

      {editingDomain ? (
        <form onSubmit={saveSettings} className="mt-7 max-w-xl">
          <FieldLabel>Wildcard root domain</FieldLabel>
          <FormInput
            value={rootDomain}
            onBlur={() => {
              if (rootDomainUsesWildcard) setRootDomain(wildcardRootDomain(normalizedRootDomain));
            }}
            onChange={(event) => setRootDomain(event.target.value)}
            placeholder="*.pilot.aeroplane.run"
            required
            inputMode="url"
            autoComplete="off"
            variant="monochrome"
            className="border-white/15 bg-white/[0.03]"
          />
          {rootDomain.trim() && !rootDomainUsesWildcard ? (
            <p className="mt-2 text-xs leading-5 text-zinc-300">
              Include the wildcard prefix, for example *.pilot.aeroplane.run.
            </p>
          ) : (
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              Services will use URLs like {"{slug}"}.{normalizedRootDomain || "your-domain.com"}.
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="inline-flex min-h-10 w-fit items-center justify-center bg-white px-4 text-sm text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={saving || !normalizedRootDomain || !hasUnsavedChanges || !rootDomainUsesWildcard}
            >
              {saving ? "Saving..." : "Save root domain"}
            </button>
            {hasSavedDomain ? (
              <button
                type="button"
                className="inline-flex min-h-10 items-center justify-center border border-white/15 px-4 text-sm text-zinc-400 transition hover:border-white/35 hover:bg-white/[0.05] hover:text-white"
                onClick={() => {
                  setRootDomain(wildcardRootDomain(savedRootDomain));
                  setEditingDomain(false);
                }}
                disabled={saving}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {hasSavedDomain && !editingDomain ? (
        <div className="mt-7 border-y border-white/10">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 py-4 text-left"
            onClick={() => setInstructionsOpen((value) => !value)}
          >
            <span>
              <span className="block text-sm text-zinc-200">DNS setup</span>
              <span className="mt-1 block text-xs text-zinc-500">Add one wildcard A record.</span>
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-500">
              {instructionsOpen ? "Hide" : "Show"}
            </span>
          </button>

          {instructionsOpen ? (
            <div className="border-t border-white/10 pb-5">
              <div className="max-w-2xl font-mono text-[10px]">
                <div className="grid grid-cols-[100px_minmax(0,1fr)] border-b border-white/10">
                  <div className="py-3 uppercase tracking-[0.18em] text-zinc-600">Type</div>
                  <div className="py-3 text-zinc-200">A</div>
                </div>
                <div className="grid grid-cols-[100px_minmax(0,1fr)] border-b border-white/10">
                  <div className="py-3 uppercase tracking-[0.18em] text-zinc-600">Name</div>
                  <div className="py-3 text-zinc-200">
                    *
                    <span className="ml-3 text-zinc-600">{wildcardHostname}</span>
                  </div>
                </div>
                <div className="grid grid-cols-[100px_minmax(0,1fr)]">
                  <div className="py-3 uppercase tracking-[0.18em] text-zinc-600">Value</div>
                  <div className="flex min-w-0 items-center gap-2 py-3">
                    <span className="truncate text-zinc-200">{publicIp}</span>
                    <button type="button" onClick={copyIp} className="shrink-0 p-0.5 text-zinc-500 transition-colors hover:text-white" title={copiedIp ? "Copied" : "Copy IP"}>
                      <AppIcon icon={copiedIp ? CopyCheckIcon : CopyIcon} size={13} />
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="mt-5 inline-flex h-10 items-center justify-center gap-2 border border-white/15 px-3.5 text-sm text-zinc-300 transition hover:border-white/35 hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void refreshSettings()}
                disabled={verifying}
              >
                <AppIcon icon={Refresh03Icon} size={13} className={verifying ? "animate-spin" : ""} />
                Verify DNS
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="mt-5 border-l-2 border-white bg-white/[0.06] px-4 py-3 text-sm text-zinc-200">{error}</div> : null}

      {success ? (
        <div
          className={
            waitingForDns
              ? "mt-5 flex items-center gap-2 border-l-2 border-amber-400 bg-amber-400/10 px-4 py-3 text-sm text-amber-200"
              : "mt-5 flex items-center gap-2 border-l-2 border-emerald-400 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200"
          }
        >
          <AppIcon icon={waitingForDns ? AlertCircleIcon : CheckmarkCircle02Icon} size={14} />
          {success}
        </div>
      ) : null}

      <ConfirmationDialog
        open={clearDialogOpen}
        title="Remove root domain?"
        subject={wildcardRootDomain(savedRootDomain)}
        description="Aeroplane will stop generating service URLs from this wildcard root domain. Existing routing may stop working until another domain is configured."
        confirmLabel="Remove domain"
        busy={saving}
        onClose={() => setClearDialogOpen(false)}
        onConfirm={clearRootDomain}
      />
    </section>
  );
}
