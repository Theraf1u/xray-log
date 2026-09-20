"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const PAGE_SIZE_OPTIONS = [25, 100, 500, 1000] as const;
const STORAGE_KEY = "xray-analyzer-page-size";

export function usePageSize(defaultValue = 25) {
  const [pageSize, setPageSizeState] = useState(defaultValue);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    if (PAGE_SIZE_OPTIONS.includes(saved as (typeof PAGE_SIZE_OPTIONS)[number])) {
      setPageSizeState(saved);
    }
  }, []);

  const setPageSize = (value: number) => {
    setPageSizeState(value);
    window.localStorage.setItem(STORAGE_KEY, String(value));
  };

  return [pageSize, setPageSize] as const;
}

interface PageSizeSelectProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function PageSizeSelect({ value, onChange, disabled }: PageSizeSelectProps) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
      <span>Строк:</span>
      <Select
        value={String(value)}
        onValueChange={(next) => onChange(Number(next))}
      >
        <SelectTrigger className="h-9 w-[92px]" disabled={disabled}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PAGE_SIZE_OPTIONS.map((size) => (
            <SelectItem key={size} value={String(size)}>{size}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
