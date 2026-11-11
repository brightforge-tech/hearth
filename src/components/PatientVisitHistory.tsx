import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { sessionToken } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/useAuth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

interface PatientVisitHistoryProps {
  patientId: string;
  patientName?: string;
}

/** The signature PNG. The storage route needs the session's bearer token,
 *  which an <img src> cannot send, so the bytes are fetched and shown from
 *  an object URL that is released again on unmount. */
function SignatureImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    const url = supabase.storage.from("signatures").getPublicUrl(path).data.publicUrl;
    const token = sessionToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (failed) return <p className="text-xs text-muted-foreground italic">Signature image unavailable</p>;
  if (!src) return <p className="text-xs text-muted-foreground">Loading signature…</p>;
  return <img src={src} alt="Patient signature" className="border rounded max-w-xs" />;
}

export function PatientVisitHistory({ patientId, patientName }: PatientVisitHistoryProps) {
  const { isDoctor, loading: authLoading } = useAuth();

  // Fetch visit history with notes
  const visitHistoryQuery = useQuery({
    queryKey: ["patient-visit-history", patientId, isDoctor],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select(
          isDoctor
            ? "id, scheduled_start, created_at, reason, status, intake_notes, visit_notes(id, notes, signature_image_path, signed_at, created_at)"
            : "id, scheduled_start, created_at, reason, status, intake_notes"
        )
        .eq("patient_id", patientId)
        .in("status", ["completed", "in_progress"])
        .order("scheduled_start", { ascending: false });
      
      if (error) throw error;
      return data;
    },
    enabled: !authLoading && !!patientId,
  });

  if (visitHistoryQuery.isLoading || authLoading) {
    return <div className="text-sm text-muted-foreground">Loading visit history...</div>;
  }

  if (!visitHistoryQuery.data || visitHistoryQuery.data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Visit History</CardTitle>
          <CardDescription>
            {patientName ? `No completed visits found for ${patientName}` : "No completed visits found for this patient"}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Visit History</h3>
        {patientName && <p className="text-sm text-muted-foreground">Patient: {patientName}</p>}
      </div>
      {!isDoctor && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Clinical notes are visible to users tagged as Doctor only. Intake notes are shown below.
          </AlertDescription>
        </Alert>
      )}
      
      <div className="space-y-4">
        {(visitHistoryQuery.data as any[]).map((visit: any) => (
          <Card key={visit.id}>
            <CardHeader>
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle className="text-base">
                    {new Date(visit.scheduled_start).toLocaleDateString()} - {visit.reason || "General Visit"}
                  </CardTitle>
                  <CardDescription>
                    Visit on {new Date(visit.scheduled_start).toLocaleString()}
                  </CardDescription>
                </div>
                <Badge variant={visit.status === "completed" ? "default" : "secondary"}>
                  {visit.status}
                </Badge>
              </div>
            </CardHeader>
            
            <CardContent className="space-y-4">
              {visit.intake_notes && (
                <div className="space-y-2">
                  <Separator />
                  <div>
                    <h4 className="font-medium text-sm">Intake Notes</h4>
                    <div className="bg-muted p-3 rounded-md">
                      <pre className="whitespace-pre-wrap text-sm">{visit.intake_notes}</pre>
                    </div>
                  </div>
                </div>
              )}
              
              {visit.visit_notes && visit.visit_notes.length > 0 && (
                visit.visit_notes.map((note: any) => (
                  <div key={note.id} className="space-y-2">
                    <Separator />
                    <div>
                      <h4 className="font-medium text-sm">Clinical Notes</h4>
                      <p className="text-sm text-muted-foreground mb-2">
                        Recorded: {new Date(note.created_at).toLocaleString()}
                      </p>
                      {note.notes ? (
                        <div className="bg-muted p-3 rounded-md">
                          <pre className="whitespace-pre-wrap text-sm font-mono">{note.notes}</pre>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No notes recorded</p>
                      )}
                    </div>
                    
                    {note.signature_image_path && (
                      <div>
                        <h5 className="font-medium text-sm mb-1">Patient Signature</h5>
                        <SignatureImage path={note.signature_image_path} />
                        {note.signed_at && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Signed: {new Date(note.signed_at).toLocaleString()}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
            
            {(!visit.visit_notes || visit.visit_notes.length === 0) && !visit.intake_notes && (
              <CardContent>
                <p className="text-sm text-muted-foreground italic">No notes recorded for this visit</p>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}