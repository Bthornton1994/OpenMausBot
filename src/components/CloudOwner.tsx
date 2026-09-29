import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { t } from "@/lib/i18n";
import { cloudOwnerOf } from "@/lib/session";
import { api } from "@/state/store";

/** Whose OMB Cloud this browser is signed in to, in the sidebar. Shown only
 * for a browser sign-in on a Cloud home (docs/cloud-pro.md); everywhere else
 * it renders nothing. */
export function CloudOwner({ compact = false }: { compact?: boolean }) {
  const [owner, setOwner] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api("/api/auth/session").then((session) => { if (active) setOwner(cloudOwnerOf(session)); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return owner ? <CloudOwnerLine owner={owner} compact={compact} /> : null;
}

export function CloudOwnerLine({ owner, compact = false }: { owner: string; compact?: boolean }) {
  const text = t("sidebar.cloudOwner", { email: owner });
  return <div className={`flex items-center gap-2 py-1.5 text-[12px] text-ink-secondary ${compact ? "justify-center px-1" : "px-4"}`} title={text}>
    <Cloud size={14} className="shrink-0" aria-hidden="true" />
    {compact ? <span className="sr-only">{text}</span> : <span className="min-w-0 truncate">{text}</span>}
  </div>;
}
