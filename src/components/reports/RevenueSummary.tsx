import { useQuery } from "@tanstack/react-query";
import { useClinicCurrency, formatMoney, DEFAULT_CURRENCY } from "@/lib/currency";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, TrendingUp, Calendar, TrendingDown } from "lucide-react";
import { format, startOfDay, startOfWeek, startOfMonth, endOfDay, endOfWeek, endOfMonth } from "date-fns";

interface RevenueData {
  period: string;
  total_revenue: number;
  paid_amount: number;
  outstanding: number;
  invoice_count: number;
  total_expenses: number;
  net_profit: number;
}

export function RevenueSummary() {
  const currency = useClinicCurrency();
  const today = new Date();
  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const monthStart = startOfMonth(today);

  const { data: dailyRevenue, isLoading: dailyLoading } = useQuery({
    queryKey: ["revenue-daily"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("total, paid_amount, status, created_at")
        .gte('created_at', startOfDay(today).toISOString())
        .lte('created_at', endOfDay(today).toISOString());

      if (error) throw error;

      const { data: expenses, error: expenseError } = await supabase
        .from("expenses")
        .select("amount")
        .eq("expense_date", format(today, 'yyyy-MM-dd'));
        
      if (expenseError) throw expenseError;
      
      const totalRevenue = data.reduce((sum, inv) => sum + (inv.total || 0), 0);
      const paidAmount = data.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0);
      const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
      const outstanding = totalRevenue - paidAmount;
      const netProfit = paidAmount - totalExpenses;
      
      return {
        period: "Today",
        total_revenue: totalRevenue,
        paid_amount: paidAmount,
        outstanding,
        invoice_count: data.length,
        total_expenses: totalExpenses,
        net_profit: netProfit
      };
    },
  });

  const { data: weeklyRevenue, isLoading: weeklyLoading } = useQuery({
    queryKey: ["revenue-weekly"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("total, paid_amount, status, created_at")
        .gte('created_at', weekStart.toISOString())
        .lte('created_at', endOfWeek(today).toISOString());

      if (error) throw error;

      const { data: expenses, error: expenseError } = await supabase
        .from("expenses")
        .select("amount")
        .gte("expense_date", format(weekStart, 'yyyy-MM-dd'))
        .lte("expense_date", format(endOfWeek(today), 'yyyy-MM-dd'));
        
      if (expenseError) throw expenseError;
      
      const totalRevenue = data.reduce((sum, inv) => sum + (inv.total || 0), 0);
      const paidAmount = data.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0);
      const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
      const outstanding = totalRevenue - paidAmount;
      const netProfit = paidAmount - totalExpenses;
      
      return {
        period: "This Week",
        total_revenue: totalRevenue,
        paid_amount: paidAmount,
        outstanding,
        invoice_count: data.length,
        total_expenses: totalExpenses,
        net_profit: netProfit
      };
    },
  });

  const { data: monthlyRevenue, isLoading: monthlyLoading } = useQuery({
    queryKey: ["revenue-monthly"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("total, paid_amount, status, created_at")
        .gte('created_at', monthStart.toISOString())
        .lte('created_at', endOfMonth(today).toISOString());

      if (error) throw error;

      const { data: expenses, error: expenseError } = await supabase
        .from("expenses")
        .select("amount")
        .gte("expense_date", format(monthStart, 'yyyy-MM-dd'))
        .lte("expense_date", format(endOfMonth(today), 'yyyy-MM-dd'));
        
      if (expenseError) throw expenseError;
      
      const totalRevenue = data.reduce((sum, inv) => sum + (inv.total || 0), 0);
      const paidAmount = data.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0);
      const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
      const outstanding = totalRevenue - paidAmount;
      const netProfit = paidAmount - totalExpenses;
      
      return {
        period: "This Month",
        total_revenue: totalRevenue,
        paid_amount: paidAmount,
        outstanding,
        invoice_count: data.length,
        total_expenses: totalExpenses,
        net_profit: netProfit
      };
    },
  });

  const formatCurrency = (amount: number) => {
    return formatMoney(amount, currency);
  };

  const RevenueCard = ({ data, isLoading, icon: Icon }: { 
    data: RevenueData | undefined, 
    isLoading: boolean, 
    icon: React.ElementType 
  }) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{data?.period}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="space-y-2">
            <div className="text-2xl font-bold">
              {formatCurrency(data?.total_revenue || 0)}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Paid: {formatCurrency(data?.paid_amount || 0)}</div>
              <div>Outstanding: {formatCurrency(data?.outstanding || 0)}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Expenses: -{formatCurrency(data?.total_expenses || 0)}</div>
              <div className={`${(data?.net_profit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                Net: {formatCurrency(data?.net_profit || 0)}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {data?.invoice_count || 0} invoices
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {/* Revenue Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <RevenueCard 
          data={dailyRevenue} 
          isLoading={dailyLoading} 
          icon={DollarSign} 
        />
        <RevenueCard 
          data={weeklyRevenue} 
          isLoading={weeklyLoading} 
          icon={TrendingUp} 
        />
        <RevenueCard 
          data={monthlyRevenue} 
          isLoading={monthlyLoading} 
          icon={Calendar} 
        />
      </div>

      {/* Profit & Loss Analysis */}
      <Card>
        <CardHeader>
          <CardTitle>Profit & Loss Analysis</CardTitle>
          <CardDescription>
            Revenue, expenses, and profitability breakdown
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <h4 className="text-sm font-medium mb-2">Collection Rate</h4>
              <div className="space-y-2">
                {[dailyRevenue, weeklyRevenue, monthlyRevenue].map((data, index) => {
                  if (!data) return null;
                  const collectionRate = data.total_revenue > 0 
                    ? (data.paid_amount / data.total_revenue) * 100 
                    : 0;
                  
                  return (
                    <div key={index} className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{data.period}</span>
                      <span className="text-sm font-medium">
                        {collectionRate.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Total Expenses</h4>
              <div className="space-y-2">
                {[dailyRevenue, weeklyRevenue, monthlyRevenue].map((data, index) => {
                  if (!data) return null;
                  
                  return (
                    <div key={index} className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{data.period}</span>
                      <span className="text-sm font-medium text-red-600">
                        -{formatCurrency(data.total_expenses)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            
            <div>
              <h4 className="text-sm font-medium mb-2">Net Profit</h4>
              <div className="space-y-2">
                {[dailyRevenue, weeklyRevenue, monthlyRevenue].map((data, index) => {
                  if (!data) return null;
                  
                  return (
                    <div key={index} className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{data.period}</span>
                      <span className={`text-sm font-medium ${data.net_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(data.net_profit)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}