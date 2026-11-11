import { BRAND } from "@/lib/brand";
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Logo } from "@/components/Logo";
import {LogoFooter} from "@/components/LogoFooter";
import { Calendar, Clock, MapPin, Phone, Mail, Heart, Shield, Users, Award, TestTube, UserCheck, Stethoscope, Syringe, Scan } from "lucide-react";
import { Link } from "react-router-dom";

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

export default function LandingPage() {
  useMeta(
    `${BRAND.name} | Quality Healthcare Services`,
    "Professional medical care with compassionate service. Book your appointment today for consultations, check-ups, and specialized treatments.",
    window.location.origin
  );

  const { toast } = useToast();
  const [showBooking, setShowBooking] = useState(false);
  const [formData, setFormData] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    date_of_birth: "",
    reason: "",
    preferred_date: "",
    preferred_time: ""
  });

  const servicesQuery = useQuery({
    queryKey: ["public-services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("id, name, description")
        .eq("active", true)
        .eq("show_on_landing", true)
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  const bookAppointment = useMutation({
    mutationFn: async (data: any) => {
      // Create patient first
      const { data: patient, error: patientError } = await supabase
        .from("patients")
        .insert({
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone,
          date_of_birth: data.date_of_birth || null,
        })
        .select()
        .single();

      if (patientError) throw patientError;

      // Create appointment
      const appointmentDate = new Date(`${data.preferred_date}T${data.preferred_time}`);
      const { error: appointmentError } = await supabase
        .from("appointments")
        .insert({
          patient_id: patient.id,
          reason: data.reason,
          scheduled_start: appointmentDate.toISOString(),
          status: "scheduled",
          customer_type: "appointment"
        });

      if (appointmentError) throw appointmentError;
    },
    onSuccess: () => {
      toast({ 
        title: "Appointment Requested", 
        description: "We'll contact you shortly to confirm your appointment time." 
      });
      setShowBooking(false);
      setFormData({
        first_name: "",
        last_name: "",
        email: "",
        phone: "",
        date_of_birth: "",
        reason: "",
        preferred_date: "",
        preferred_time: ""
      });
    },
    onError: (error: any) => {
      toast({ 
        title: "Booking Error", 
        description: error.message || "Please try again or call us directly.",
        variant: "destructive"
      });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/60 sticky top-0 z-50">
        <nav className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-6">
            <a href="#services" className="text-sm font-medium hover:text-primary transition-colors">Services</a>
            <a href="#about" className="text-sm font-medium hover:text-primary transition-colors">About</a>
            <a href="#contact" className="text-sm font-medium hover:text-primary transition-colors">Contact</a>
            <Button variant="outline" asChild>
              <Link to="/auth">Staff Login</Link>
            </Button>
            <Button onClick={() => setShowBooking(true)}>Book Appointment</Button>
          </div>
        </nav>
      </header>

      {/* Hero Section */}
      <section 
        className="py-20 bg-cover bg-center bg-no-repeat relative"
        style={{ backgroundImage: "linear-gradient(135deg, #0f3d3e 0%, #0e7490 55%, #134e4a 100%)" }}
      >
        <div className="absolute inset-0 bg-black/50"></div>
        <div className="container mx-auto px-4 text-center relative z-10">
          <div className="max-w-3xl mx-auto">
            <h1 className="text-4xl md:text-6xl font-bold mb-6 text-white">
              Your Health, Our Priority
            </h1>
            <p className="text-xl text-white/90 mb-8 leading-relaxed">
              Experience compassionate, professional healthcare at {BRAND.name}. 
              We're dedicated to providing comprehensive medical services with a personal touch.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" onClick={() => setShowBooking(true)} className="text-lg px-8 py-6">
                Book Your Appointment
              </Button>
              <Button variant="outline" size="lg" className="text-lg px-8 py-6">
                <Phone className="mr-2 h-5 w-5" />
                Call Us Today
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section id="services" className="py-20 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, hsl(var(--medical-green)/0.05) 0%, hsl(var(--primary)/0.1) 100%)' }}>
        {/* Background Pattern */}
        <div className="absolute inset-0 opacity-5">
          <div className="absolute top-10 left-10 w-20 h-20 rounded-full bg-primary/20"></div>
          <div className="absolute top-32 right-20 w-16 h-16 rounded-full bg-primary/15"></div>
          <div className="absolute bottom-20 left-1/4 w-12 h-12 rounded-full bg-primary/10"></div>
          <div className="absolute bottom-32 right-1/3 w-24 h-24 rounded-full bg-primary/20"></div>
        </div>
        
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center mb-16">
            <div className="inline-block px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-4">
              Our Expertise
            </div>
            <h2 className="text-4xl md:text-5xl font-bold mb-6 bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
              Our Medical Services
            </h2>
            <p className="text-muted-foreground max-w-3xl mx-auto text-lg leading-relaxed">
              We offer a comprehensive range of medical services to meet all your healthcare needs with compassionate, professional care
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {servicesQuery.data?.map((service, index) => {
              const serviceIcons = {
                "Blood Test": TestTube,
                "Follow-up Visit": UserCheck, 
                "Initial Consultation": Stethoscope,
                "Injection": Syringe,
                "X-Ray": Scan
              };
              
              const IconComponent = serviceIcons[service.name as keyof typeof serviceIcons] || Heart;
              
              return (
                <Card 
                  key={service.id} 
                  className="group relative overflow-hidden border-0 shadow-lg hover:shadow-2xl transition-all duration-300 hover:-translate-y-2 bg-white/80 backdrop-blur-sm animate-fade-in"
                  style={{ animationDelay: `${index * 0.1}s` }}
                >
                  {/* Gradient overlay */}
                  <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  
                  <CardHeader className="relative z-10 pb-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="p-3 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 group-hover:from-primary/20 group-hover:to-primary/10 transition-all duration-300">
                        <IconComponent className="h-6 w-6 text-primary" />
                      </div>
                      <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border-primary/20">
                        Available
                      </Badge>
                    </div>
                    <CardTitle className="text-xl font-bold group-hover:text-primary transition-colors duration-300">
                      {service.name}
                    </CardTitle>
                  </CardHeader>
                  
                  <CardContent className="relative z-10 pt-0">
                    <p className="text-muted-foreground mb-6 leading-relaxed">
                      {service.description || "Professional medical service tailored to your health needs with expert care and attention"}
                    </p>
                    <Button 
                      onClick={() => setShowBooking(true)}
                      className="w-full bg-gradient-to-r from-primary to-primary/90 hover:from-primary/90 hover:to-primary text-white font-medium py-2.5 rounded-lg transition-all duration-300 hover:shadow-lg hover:shadow-primary/25"
                    >
                      Book Appointment
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          
          {/* Call to Action */}
          {/*}
          <div className="text-center mt-16">
            <div className="inline-flex items-center gap-2 text-muted-foreground text-sm mb-4">
              <Shield className="h-4 w-4" />
              <span>All services performed by licensed medical professionals</span>
            </div>
            <Button 
              size="lg" 
              onClick={() => setShowBooking(true)}
              className="bg-gradient-to-r from-primary to-primary/90 hover:from-primary/90 hover:to-primary text-white px-8 py-3 text-lg font-medium rounded-lg transition-all duration-300 hover:shadow-lg hover:shadow-primary/25"
            >
              Schedule Your Visit Today
            </Button>
          </div>
          */}
        </div>
      </section>

      {/* About Section */}
      <section id="about" className="py-16 bg-muted/30">
        <div className="container mx-auto px-4">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-6">Why Choose {BRAND.shortName}?</h2>
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                  <Shield className="h-6 w-6 text-primary mt-1" />
                  <div>
                    <h3 className="font-semibold mb-2">Professional Excellence</h3>
                    <p className="text-muted-foreground">Our experienced medical professionals provide the highest standard of care.</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <Users className="h-6 w-6 text-primary mt-1" />
                  <div>
                    <h3 className="font-semibold mb-2">Patient-Centered Care</h3>
                    <p className="text-muted-foreground">We put your health and comfort at the center of everything we do.</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <Award className="h-6 w-6 text-primary mt-1" />
                  <div>
                    <h3 className="font-semibold mb-2">Trusted in the Community</h3>
                    <p className="text-muted-foreground">Years of dedicated service to our local community.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-white p-8 rounded-lg shadow-lg">
              <h3 className="text-xl font-semibold mb-4">Quick Contact</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Phone className="h-5 w-5 text-primary" />
                  <span>{BRAND.phone}</span>
                </div>
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-primary" />
                  <span>{BRAND.email}</span>
                </div>
                <div className="flex items-center gap-3">
                  <MapPin className="h-5 w-5 text-primary" />
                  <span>{BRAND.address}</span>
                </div>
                <div className="flex items-center gap-3">
                  <Clock className="h-5 w-5 text-primary" />
                  <span>{BRAND.hours}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer id="contact" className="py-8 border-t" style={{ backgroundColor: 'hsl(var(--medical-green))' }}>
        <div className="container mx-auto px-4 text-center">
          <LogoFooter className="h-12 w-auto mx-auto mb-4" showText={false} />
          <p className="text-white/90 mb-4">
            &copy; {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <div className="flex justify-center gap-6">
            <a href="#" className="text-white/80 hover:text-white transition-colors">Privacy Policy</a>
            <a href="#" className="text-white/80 hover:text-white transition-colors">Terms of Service</a>
            <Link to="/auth" className="text-white/80 hover:text-white transition-colors">Staff Login</Link>
          </div>
        </div>
      </footer>

      {/* Booking Dialog */}
      <Dialog open={showBooking} onOpenChange={setShowBooking}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Book Your Appointment</DialogTitle>
            <DialogDescription>Fill out the form below and we'll contact you to confirm your appointment.</DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              bookAppointment.mutate(formData);
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="first_name">First Name</Label>
                <Input
                  id="first_name"
                  value={formData.first_name}
                  onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="last_name">Last Name</Label>
                <Input
                  id="last_name"
                  value={formData.last_name}
                  onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  required
                />
              </div>
            </div>

            <div>
              <Label htmlFor="reason">Reason for Visit</Label>
              <Textarea
                id="reason"
                value={formData.reason}
                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                placeholder="Brief description of your health concern or type of appointment needed"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="preferred_date">Preferred Date</Label>
                <Input
                  id="preferred_date"
                  type="date"
                  value={formData.preferred_date}
                  onChange={(e) => setFormData({ ...formData, preferred_date: e.target.value })}
                  min={new Date().toISOString().split('T')[0]}
                  required
                />
              </div>
              <div>
                <Label htmlFor="preferred_time">Preferred Time</Label>
                <Select
                  value={formData.preferred_time}
                  onValueChange={(value) => setFormData({ ...formData, preferred_time: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select time" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="09:00">9:00 AM</SelectItem>
                    <SelectItem value="10:00">10:00 AM</SelectItem>
                    <SelectItem value="11:00">11:00 AM</SelectItem>
                    <SelectItem value="14:00">2:00 PM</SelectItem>
                    <SelectItem value="15:00">3:00 PM</SelectItem>
                    <SelectItem value="16:00">4:00 PM</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={bookAppointment.isPending}>
              {bookAppointment.isPending ? "Booking..." : "Request Appointment"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}