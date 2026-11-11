import { useEffect, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiAuditExport, apiAuditList, type AuditFilters } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import { useToast } from "@/hooks/use-toast";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download } from "lucide-react";

const PAGE_SIZE = 100;
const ACTIONS = ["view", "create", "update", "delete", "export", "login", "login_failed", "logout"] as const;
const ANY = "__any__";

const EMPTY: AuditFilters = { from: "", to: "", actor: "", action: "", entity_type: "", entity_id: "" };

// The summary holds field names and counts (never values): show it compactly.
function formatSummary(summary: unknown): string {
  if (summary === null || summary === undefined || summary === "") return "";
  if (typeof summary === "string") return summary;
  if (typeof summary !== "object") return String(summary);
  return Object.entries(summary as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join("; ");
}

export default function AuditLog() {
  const { toast } = useToast();
  // `draft` is what the form shows; `filters` is what was last applied.
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    document.title = `Audit Log | ${BRAND.name}`;
  }, []);

  const query = useQuery({
    queryKey: ["audit-log", filters, page],
    queryFn: () => apiAuditList({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const apply = (e?: React.FormEvent) => {
    e?.preventDefault();
    setFilters({ ...draft });
    setPage(0);
  };

  const reset = () => {
    setDraft(EMPTY);
    setFilters(EMPTY);
    setPage(0);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const csv = await apiAuditExport(filters);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit-log-${format(new Date(), "yyyy-MM-dd-HHmm")}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast({ title: "Export ready", description: "The audit log CSV has been downloaded." });
    } catch (e: any) {
      toast({ title: "Export failed", description: e?.message || "Could not export the audit log.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const set = (key: keyof AuditFilters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/admin/audit" />

      <main className="container mx-auto px-4 py-6 space-y-6">
        <section className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Audit Log</h1>
            <p className="text-sm text-muted-foreground">Who viewed, changed or exported what, and when.</p>
          </div>
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "Exporting..." : "Export CSV"}
          </Button>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Filters</CardTitle>
            <CardDescription>The CSV export uses the applied filters.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={apply} className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4 items-end">
              <div>
                <Label htmlFor="audit-from">From</Label>
                <Input id="audit-from" type="date" value={draft.from} onChange={set("from")} />
              </div>
              <div>
                <Label htmlFor="audit-to">To</Label>
                <Input id="audit-to" type="date" value={draft.to} onChange={set("to")} />
              </div>
              <div>
                <Label htmlFor="audit-actor">Actor (email)</Label>
                <Input id="audit-actor" value={draft.actor} onChange={set("actor")} placeholder="part of an email" />
              </div>
              <div>
                <Label htmlFor="audit-action">Action</Label>
                <Select
                  value={draft.action || ANY}
                  onValueChange={(v) => setDraft((prev) => ({ ...prev, action: v === ANY ? "" : v }))}
                >
                  <SelectTrigger id="audit-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any action</SelectItem>
                    {ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="audit-entity-type">Entity type</Label>
                <Input id="audit-entity-type" value={draft.entity_type} onChange={set("entity_type")} placeholder="e.g. patients" />
              </div>
              <div>
                <Label htmlFor="audit-entity-id">Entity id</Label>
                <Input id="audit-entity-id" value={draft.entity_id} onChange={set("entity_id")} />
              </div>
              <div className="md:col-span-3 lg:col-span-6 flex gap-2">
                <Button type="submit">Apply filters</Button>
                <Button type="button" variant="outline" onClick={reset}>Clear</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Entries</CardTitle>
              <CardDescription>
                {query.isLoading ? "Loading…" : `${total} entr${total === 1 ? "y" : "ies"}`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page === 0 || query.isFetching} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-muted-foreground">
                Page {page + 1} of {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pages || query.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {query.error ? (
              <div className="text-sm text-destructive">Could not load the audit log: {(query.error as Error).message}</div>
            ) : query.data && query.data.rows.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No entries match these filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead>IP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data?.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">{new Date(row.at).toLocaleString()}</TableCell>
                        <TableCell>
                          <div>{row.actor_email || "—"}</div>
                          {row.actor_role && <div className="text-xs text-muted-foreground">{row.actor_role}</div>}
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.action === "delete" || row.action === "login_failed" ? "destructive" : "outline"}>
                            {row.action}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div>{row.entity_type || "—"}</div>
                          {row.entity_id && <div className="text-xs text-muted-foreground font-mono break-all">{row.entity_id}</div>}
                        </TableCell>
                        <TableCell className="max-w-md break-words">{formatSummary(row.summary)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{row.ip || ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <AppFooter />
    </div>
  );
}
