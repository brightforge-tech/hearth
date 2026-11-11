import { BRAND } from "@/lib/brand";
import { useClinicCurrency, formatMoney, DEFAULT_CURRENCY } from "@/lib/currency";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Navigation } from "@/components/Navigation";

function useMeta(title: string, description: string, canonical: string) {
  useEffect(() => {
    document.title = title;
    const meta = document.querySelector('meta[name="description"]') || document.createElement("meta");
    meta.setAttribute("name", "description");
    meta.setAttribute("content", description);
    if (!meta.parentNode) document.head.appendChild(meta);
    let link: HTMLLinkElement | null = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", canonical);
  }, [title, description, canonical]);
}

function dataURLtoBlob(dataURL: string) {
  const arr = dataURL.split(",");
  const mime = arr[0].match(/:(.*?);/)![1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new Blob([u8arr], { type: mime });
}

export default function Visit() {
  const currency = useClinicCurrency();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useMeta(
    `Visit Notes & Services | ${BRAND.name}`,
    "Record visit notes, capture signature, and select billable services.",
    window.location.origin + `/visit/${id}`
  );

  const notesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [selectedServices, setSelectedServices] = useState<Array<{id: string, name: string, price: number, taxable: boolean}>>([]);
  const [comboboxOpen, setComboboxOpen] = useState(false);

  const apptQuery = useQuery({
    queryKey: ["appointment", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("id, status, scheduled_start, patient:patients(first_name,last_name)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!id,
    retry: 3,
  });

  // Show error if appointment not found
  if (apptQuery.isError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Visit Not Found</h1>
          <p className="text-muted-foreground mb-4">The requested appointment could not be found.</p>
          <Button asChild>
            <a href="/queue">Return to Queue</a>
          </Button>
        </div>
      </div>
    );
  }

  const servicesQuery = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("id, code, name, price, taxable, active")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data as any[];
    },
  });

  // Real-time subscriptions for visit updates
  useEffect(() => {
    if (!id) return;

    const appointmentChannel = supabase
      .channel(`appointment-${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'appointments',
          filter: `id=eq.${id}`
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["appointment", id] });
        }
      )
      .subscribe();

    const servicesChannel = supabase
      .channel('services-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'services'
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["services"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(appointmentChannel);
      supabase.removeChannel(servicesChannel);
    };
  }, [id, queryClient]);

  useEffect(() => {
    const canvas = notesCanvasRef.current;
    if (!canvas) return;
    
    // Set canvas display size
    const rect = canvas.getBoundingClientRect();
    canvas.style.width = '100%';
    canvas.style.height = '200px';
    
    // Set canvas resolution (for high DPI displays)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(600, rect.width || 600) * dpr;
    canvas.height = 200 * dpr;
    
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Scale context for high DPI
      ctx.scale(dpr, dpr);
      
      // Set drawing properties
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#000000"; // Use solid black for signature
      
      // Set white background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    }
  }, []);

  const getCoordinates = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = notesCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    
    if ('touches' in e) {
      // Touch event
      const touch = e.touches[0] || e.changedTouches[0];
      clientX = touch.clientX;
      clientY = touch.clientY;
    } else {
      // Mouse event
      clientX = e.clientX;
      clientY = e.clientY;
    }
    
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  };

  const startDraw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // Prevent scrolling on touch
    const canvas = notesCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    
    isDrawingRef.current = true;
    const { x, y } = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // Prevent scrolling on touch
    if (!isDrawingRef.current) return;
    const canvas = notesCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    
    const { x, y } = getCoordinates(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasSignature(true);
  };

  const endDraw = () => {
    isDrawingRef.current = false;
  };

  const clearSignature = () => {
    const canvas = notesCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    setHasSignature(false);
  };

  const saveNotes = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing appointment id");

      // Upload signature if present
      let signaturePath: string | null = null;
      if (hasSignature && notesCanvasRef.current) {
        const dataUrl = notesCanvasRef.current.toDataURL("image/png");
        const blob = dataURLtoBlob(dataUrl);
        const path = `appointment_${id}/${Date.now()}.png`;
        const { error: upErr } = await supabase.storage.from("signatures").upload(path, blob, {
          contentType: "image/png",
          upsert: true,
        });
        if (upErr) throw upErr;
        signaturePath = path;
      }

      // Upsert visit notes
      const payload: any = { appointment_id: id, notes };
      if (signaturePath) {
        payload.signature_image_path = signaturePath;
        payload.signed_at = new Date().toISOString();
      }
      const { error: vnErr } = await supabase
        .from("visit_notes")
        .upsert(payload, { onConflict: "appointment_id" });
      if (vnErr) throw vnErr;
    },
    onSuccess: () => toast({ title: "Notes saved", description: "Visit notes and signature updated." }),
    onError: (e: any) => toast({ title: "Error", description: e?.message || "Could not save notes.", variant: "destructive" as any }),
  });

  const generateInvoice = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing appointment id");
      const selected = Object.entries(qty)
        .filter(([, q]) => q && q > 0)
        .map(([sid, q]) => ({ service_id: sid, quantity: q }));
      if (selected.length === 0) throw new Error("Select at least one service with quantity > 0");

      // Create invoice
      const { data: inv, error: invErr } = await supabase
        .from("invoices")
        .insert({ appointment_id: id })
        .select("id")
        .maybeSingle();
      if (invErr) throw invErr;
      const invoiceId = inv!.id as string;

      // Fetch services to resolve price/taxable
      const serviceMap = new Map<string, any>();
      servicesQuery.data?.forEach((s) => serviceMap.set(s.id, s));

      const items = selected.map(({ service_id, quantity }) => {
        const s = serviceMap.get(service_id);
        return {
          invoice_id: invoiceId,
          service_id,
          description: s?.name || "Service",
          quantity,
          unit_price: s?.price ?? 0,
          taxable: s?.taxable ?? true,
        };
      });
      const { error: itErr } = await supabase.from("invoice_items").insert(items);
      if (itErr) throw itErr;

      // Set invoice to issued and appointment completed
      const { error: upInvErr } = await supabase.from("invoices").update({ status: "issued" }).eq("id", invoiceId);
      if (upInvErr) throw upInvErr;
      const { error: apptUpErr } = await supabase.from("appointments").update({ status: "completed" }).eq("id", id);
      if (apptUpErr) throw apptUpErr;

      return invoiceId;
    },
    onSuccess: () => {
      toast({ title: "Invoice generated", description: "Services added and totals calculated." });
      navigate("/queue");
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message || "Could not generate invoice.", variant: "destructive" as any }),
  });

  const totalEstimate = useMemo(() => {
    const map = new Map<string, any>();
    servicesQuery.data?.forEach((s) => map.set(s.id, s));
    let subtotal = 0;
    Object.entries(qty).forEach(([sid, q]) => {
      if (!q || q <= 0) return;
      const s = map.get(sid);
      subtotal += (s?.price || 0) * q;
    });
    return subtotal;
  }, [qty, servicesQuery.data]);

  // Add Initial Consultation by default when services load
  useEffect(() => {
    if (servicesQuery.data && servicesQuery.data.length > 0 && selectedServices.length === 0) {
      const consultation = servicesQuery.data.find(s => s.name === "Initial Consultation");
      if (consultation) {
        setSelectedServices([consultation]);
        setQty({ [consultation.id]: 1 });
      }
    }
  }, [servicesQuery.data, selectedServices.length]);

  const addService = (service: any) => {
    if (!selectedServices.find(s => s.id === service.id)) {
      setSelectedServices([...selectedServices, service]);
      setQty(prev => ({ ...prev, [service.id]: 1 }));
    }
    setComboboxOpen(false);
  };

  const removeService = (serviceId: string) => {
    setSelectedServices(prev => prev.filter(s => s.id !== serviceId));
    setQty(prev => {
      const newQty = { ...prev };
      delete newQty[serviceId];
      return newQty;
    });
  };

  const availableServices = servicesQuery.data?.filter(service => 
    !selectedServices.find(selected => selected.id === service.id)
  ) || [];

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/visit" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Visit Notes & Services</h1>
              <p className="text-sm text-muted-foreground">
                Patient: {apptQuery.data?.patient?.first_name} {apptQuery.data?.patient?.last_name}
                {apptQuery.data?.status && (
                  <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                    {apptQuery.data.status}
                  </span>
                )}
              </p>
            </div>
            <Button variant="outline" asChild>
              <a href="/queue">Back to Queue</a>
            </Button>
          </div>
        </section>

        <div className="grid lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Clinical Notes</CardTitle>
              <CardDescription>Enter notes and capture signature</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="SOAP or free text…" />
              </div>
              <div>
                <Label>Signature</Label>
                <div className="border rounded-md p-2 bg-white">
                  <canvas
                    ref={notesCanvasRef}
                    className="w-full h-[200px] rounded-sm border border-gray-200 bg-white touch-none"
                    onMouseDown={startDraw}
                    onMouseMove={draw}
                    onMouseUp={endDraw}
                    onMouseLeave={endDraw}
                    onTouchStart={startDraw}
                    onTouchMove={draw}
                    onTouchEnd={endDraw}
                    style={{ touchAction: 'none' }}
                  />
                  <div className="mt-2 flex gap-2">
                    <Button variant="outline" onClick={clearSignature}>Clear</Button>
                    <Button onClick={() => saveNotes.mutate()} disabled={saveNotes.isPending}>
                      {saveNotes.isPending ? "Saving…" : "Save Notes"}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Billable Services</CardTitle>
              <CardDescription>Select services and set quantities</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {servicesQuery.isLoading && <div className="text-sm text-muted-foreground">Loading services…</div>}
              
              {/* Add Service Dropdown */}
              <div className="space-y-2">
                <Label>Add Service</Label>
                <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={comboboxOpen}
                      className="w-full justify-between"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Search and add services...
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search services..." className="h-9" />
                      <CommandList>
                        <CommandEmpty>No services found.</CommandEmpty>
                        <CommandGroup>
                          {availableServices.map((service) => (
                            <CommandItem
                              key={service.id}
                              value={service.name}
                              onSelect={() => addService(service)}
                              className="cursor-pointer"
                            >
                              <div className="flex flex-col flex-1">
                                <div className="font-medium">{service.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {currency} ${Number(service.price).toFixed(2)}{service.taxable ? " • taxable" : ""}
                                </div>
                              </div>
                              <Check
                                className={cn(
                                  "ml-auto h-4 w-4",
                                  "opacity-0"
                                )}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Selected Services */}
              <div className="space-y-3">
                {selectedServices.map((service) => (
                  <div key={service.id} className="flex items-center justify-between gap-3 border rounded-md p-3">
                    <div className="flex-1">
                      <div className="font-medium">{service.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {currency} ${Number(service.price).toFixed(2)}{service.taxable ? " • taxable" : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`qty-${service.id}`} className="text-xs">Qty</Label>
                      <Input
                        id={`qty-${service.id}`}
                        type="number"
                        min={1}
                        className="w-20"
                        value={qty[service.id] ?? 1}
                        onChange={(e) => setQty(prev => ({ ...prev, [service.id]: Math.max(1, Number(e.target.value)) }))}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removeService(service.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">Estimated subtotal</div>
                <div className="font-semibold">{currency} ${totalEstimate.toFixed(2)}</div>
              </div>
              <div>
                <Button onClick={() => generateInvoice.mutate()} disabled={generateInvoice.isPending}>
                  {generateInvoice.isPending ? "Generating…" : "Generate Invoice"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
