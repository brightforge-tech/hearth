import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Edit, Trash2, Camera, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useFeatures } from "@/hooks/useFeatures";
import { apiAnalyzeReceipt } from "@/lib/api";
import { useClinicCurrency, formatMoney } from "@/lib/currency";
import { AppFooter } from "@/components/AppFooter";
import { format, parseISO } from "date-fns";

interface Expense {
  id: string;
  description: string;
  amount: number;
  category: string;
  expense_date: string;
  reference?: string;
  notes?: string;
  created_at: string;
}

// Local calendar date as YYYY-MM-DD (toISOString would give the UTC day).
const today = () => format(new Date(), "yyyy-MM-dd");

const RECEIPT_NOTICE = "The receipt image is sent to the configured AI provider.";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

const EXPENSE_CATEGORIES = [
  "Office Supplies",
  "Medical Equipment",
  "Rent",
  "Utilities",
  "Insurance",
  "Marketing",
  "Professional Services",
  "Maintenance",
  "Software Subscriptions",
  "Training & Education",
  "Travel",
  "Meals & Entertainment",
  "Other"
];

const Expenses = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [formData, setFormData] = useState({
    description: "",
    amount: "",
    category: "",
    expense_date: today(),
    reference: "",
    notes: ""
  });
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { hasRole } = useAuth();
  const canDelete = hasRole("admin");
  const features = useFeatures();
  const receiptScanning = features.receipt_scanning;
  const currency = useClinicCurrency();

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ["expenses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select("*")
        .order("expense_date", { ascending: false });
      
      if (error) throw error;
      return ((data as Expense[]) || []).map((e) => ({ ...e, amount: Number(e.amount) || 0 }));
    }
  });

  const addExpenseMutation = useMutation({
    mutationFn: async (expenseData: any) => {
      const { error } = await supabase.from("expenses").insert([expenseData]);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      setIsDialogOpen(false);
      resetForm();
      toast({ title: "Success", description: "Expense added successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  });

  const updateExpenseMutation = useMutation({
    mutationFn: async ({ id, ...expenseData }: any) => {
      const { error } = await supabase
        .from("expenses")
        .update(expenseData)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      setIsDialogOpen(false);
      setEditingExpense(null);
      resetForm();
      toast({ title: "Success", description: "Expense updated successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("expenses").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      toast({ title: "Success", description: "Expense deleted successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  });

  const resetForm = () => {
    setFormData({
      description: "",
      amount: "",
      category: "",
      expense_date: today(),
      reference: "",
      notes: ""
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.category) {
      toast({ title: "Missing category", description: "Please select a category.", variant: "destructive" });
      return;
    }

    const expenseData = {
      description: formData.description,
      amount: parseFloat(formData.amount),
      category: formData.category,
      expense_date: formData.expense_date,
      reference: formData.reference || null,
      notes: formData.notes || null
    };

    if (editingExpense) {
      updateExpenseMutation.mutate({ id: editingExpense.id, ...expenseData });
    } else {
      addExpenseMutation.mutate(expenseData);
    }
  };

  const handleEdit = (expense: Expense) => {
    setEditingExpense(expense);
    setFormData({
      description: expense.description,
      amount: expense.amount.toString(),
      category: expense.category,
      expense_date: expense.expense_date,
      reference: expense.reference || "",
      notes: expense.notes || ""
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this expense?")) {
      deleteExpenseMutation.mutate(id);
    }
  };

  const handleAnalyzeReceipt = async (file: File) => {
    setIsAnalyzing(true);
    try {
      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // The API forwards the image to the configured AI provider.
      const data = await apiAnalyzeReceipt(base64);

      // Fill the form with extracted data
      const category = EXPENSE_CATEGORIES.includes(data.category || "") ? (data.category as string) : "";
      setFormData({
        description: data.description || "",
        amount: data.amount !== undefined && data.amount !== null && data.amount !== "" ? String(data.amount) : "",
        category,
        expense_date: data.expense_date || today(),
        reference: data.reference || "",
        notes: data.notes || ""
      });
      setIsDialogOpen(true);

      toast({ 
        title: "Receipt Analyzed", 
        description: "Expense details have been filled from the receipt. Please review and adjust if needed." 
      });

    } catch (error: any) {
      console.error('Receipt analysis error:', error);
      toast({ 
        title: "Analysis Failed", 
        description: error.message || "Failed to analyze receipt. Please enter details manually.",
        variant: "destructive" 
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // let the same file be picked again later
    event.target.value = "";
    if (file) {
      if (file.size > MAX_RECEIPT_BYTES) {
        toast({ title: "File too large", description: "Please use an image under 8 MB.", variant: "destructive" });
        return;
      }
      if (file.type.startsWith('image/')) {
        handleAnalyzeReceipt(file);
      } else {
        toast({ 
          title: "Invalid File", 
          description: "Please upload an image file (JPG, PNG, etc.)",
          variant: "destructive" 
        });
      }
    }
  };

  const formatCurrency = (amount: number) => formatMoney(amount, currency);

  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/expenses" />
      
      <main className="container mx-auto px-4 py-6">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Expenses</h2>
            <p className="text-muted-foreground">
              Track and manage your business expenses
            </p>
          </div>
          
          <div className="flex gap-2 items-start">
            {receiptScanning && (
            <div className="flex flex-col items-end">
            <input
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
              className="hidden"
              id="receipt-upload"
              disabled={isAnalyzing}
            />
            <label htmlFor="receipt-upload">
              <Button
                asChild
                variant="outline"
                disabled={isAnalyzing}
              >
                <span className="cursor-pointer">
                  {isAnalyzing ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary mr-2"></div>
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Camera className="h-4 w-4 mr-2" />
                      Scan Receipt
                    </>
                  )}
                </span>
              </Button>
            </label>
            <p className="text-xs text-muted-foreground mt-1 max-w-[16rem] text-right">{RECEIPT_NOTICE}</p>
            </div>
            )}
            
            <Dialog open={isDialogOpen} onOpenChange={(open) => {
              setIsDialogOpen(open);
              if (!open) {
                setEditingExpense(null);
                resetForm();
              }
            }}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Expense
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>
                    {editingExpense ? "Edit Expense" : "Add New Expense"}
                  </DialogTitle>
                  <DialogDescription>
                    {editingExpense ? "Update the expense details below." : receiptScanning ? "Enter the details for the new expense or scan a receipt to auto-fill." : "Enter the details for the new expense."}
                  </DialogDescription>
                </DialogHeader>
                
                {!editingExpense && receiptScanning && (
                  <div className="mb-4">
                  <div className="flex gap-2">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      className="hidden"
                      id="receipt-upload-dialog"
                      disabled={isAnalyzing}
                    />
                    <label htmlFor="receipt-upload-dialog" className="flex-1">
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        asChild
                        disabled={isAnalyzing}
                      >
                        <span className="cursor-pointer">
                          {isAnalyzing ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary mr-2"></div>
                              Analyzing Receipt...
                            </>
                          ) : (
                            <>
                              <Upload className="h-4 w-4 mr-2" />
                              Upload Receipt
                            </>
                          )}
                        </span>
                      </Button>
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{RECEIPT_NOTICE}</p>
                  </div>
                )}
                
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Input
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="Enter expense description"
                      required
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount ({currency})</Label>
                    <Input
                      id="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={formData.amount}
                      onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                      placeholder="0.00"
                      required
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="category">Category</Label>
                    <Select value={formData.category} onValueChange={(value) => setFormData(prev => ({ ...prev, category: value }))}>
                      <SelectTrigger id="category">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPENSE_CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="expense_date">Expense Date</Label>
                    <Input
                      id="expense_date"
                      type="date"
                      value={formData.expense_date}
                      onChange={(e) => setFormData(prev => ({ ...prev, expense_date: e.target.value }))}
                      required
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="reference">Reference</Label>
                    <Input
                      id="reference"
                      value={formData.reference}
                      onChange={(e) => setFormData(prev => ({ ...prev, reference: e.target.value }))}
                      placeholder="Receipt number, invoice, etc."
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea
                      id="notes"
                      value={formData.notes}
                      onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                      placeholder="Additional notes (optional)"
                      rows={3}
                    />
                  </div>
                  
                  <DialogFooter>
                    <Button type="submit" disabled={addExpenseMutation.isPending || updateExpenseMutation.isPending || isAnalyzing}>
                      {editingExpense ? "Update Expense" : "Add Expense"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Total Expenses</CardTitle>
              <CardDescription>
                Total amount spent across all expenses
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">
                {formatCurrency(totalExpenses)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Expense List</CardTitle>
              <CardDescription>
                All recorded expenses
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-4">Loading expenses...</div>
              ) : expenses.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No expenses recorded yet. Add your first expense to get started.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expenses.map((expense) => (
                      <TableRow key={expense.id}>
                        <TableCell>
                          {format(parseISO(expense.expense_date), 'MMM dd, yyyy')}
                        </TableCell>
                        <TableCell>
                          <div>
                            <div className="font-medium">{expense.description}</div>
                            {expense.notes && (
                              <div className="text-sm text-muted-foreground">
                                {expense.notes}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{expense.category}</Badge>
                        </TableCell>
                        <TableCell>{expense.reference || "-"}</TableCell>
                        <TableCell className="text-right font-medium text-destructive">
                          -{formatCurrency(expense.amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEdit(expense)}
                              aria-label="Edit expense"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            {canDelete && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDelete(expense.id)}
                              aria-label="Delete expense"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      <AppFooter />
    </div>
  );
};

export default Expenses;