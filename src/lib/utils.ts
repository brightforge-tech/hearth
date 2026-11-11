import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** A free-text search term made safe for the query shim's or() grammar
 *  (`col.ilike.%term%,...`): separators and quoting characters are dropped so
 *  a comma or parenthesis typed into a search box cannot change the filter. */
export function orSearchTerm(term: string): string {
  return term.replace(/[,()"'\\*%:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)
}
