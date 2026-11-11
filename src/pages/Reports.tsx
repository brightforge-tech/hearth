import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TodaysSchedule } from "@/components/reports/TodaysSchedule";
import { RevenueSummary } from "@/components/reports/RevenueSummary";
import { UnpaidAging } from "@/components/reports/UnpaidAging";
import { CalendarDays, DollarSign, Clock } from "lucide-react";

const Reports = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/reports" />

      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="text-3xl font-bold tracking-tight">Reports Dashboard</h2>
          <p className="text-muted-foreground">
            View today's schedule, revenue insights, and unpaid invoice aging
          </p>
        </div>

        <Tabs defaultValue="schedule" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="schedule" className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              Today's Schedule
            </TabsTrigger>
            <TabsTrigger value="revenue" className="flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Revenue Summary
            </TabsTrigger>
            <TabsTrigger value="unpaid" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Unpaid Aging
            </TabsTrigger>
          </TabsList>

          <TabsContent value="schedule" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Today's Schedule & Queue</CardTitle>
                <CardDescription>
                  View all appointments scheduled for today and current queue status
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TodaysSchedule />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="revenue" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Revenue Summary</CardTitle>
                <CardDescription>
                  Daily, weekly, and monthly revenue analytics
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RevenueSummary />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="unpaid" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Unpaid Invoice Aging</CardTitle>
                <CardDescription>
                  Track outstanding invoices and aging analysis
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UnpaidAging />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
      <AppFooter />
    </div>
  );
};

export default Reports;