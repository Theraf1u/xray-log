"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { ChevronDown } from "lucide-react"

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
}

interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode
}

interface SelectContentProps {
  children: React.ReactNode
}

interface SelectItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
  children: React.ReactNode
}

interface SelectValueProps {
  placeholder?: string
}

const SelectContext = React.createContext<{
  value: string
  onValueChange: (value: string) => void
  open: boolean
  setOpen: (open: boolean) => void
  triggerRect: DOMRect | null
  setTriggerRect: (rect: DOMRect | null) => void
}>({
  value: "",
  onValueChange: () => {},
  open: false,
  setOpen: () => {},
  triggerRect: null,
  setTriggerRect: () => {},
})

export function Select({ value, onValueChange, children }: SelectProps) {
  const [open, setOpen] = React.useState(false)
  const [triggerRect, setTriggerRect] = React.useState<DOMRect | null>(null)

  return (
    <SelectContext.Provider value={{ value, onValueChange, open, setOpen, triggerRect, setTriggerRect }}>
      <div className="relative">
        {children}
      </div>
    </SelectContext.Provider>
  )
}

export function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  const { open, setOpen, setTriggerRect } = React.useContext(SelectContext)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  return (
    <button
      ref={triggerRef}
      type="button"
      className={cn(
        "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      onClick={() => {
        setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null)
        setOpen(!open)
      }}
      {...props}
    >
      {children}
      <ChevronDown className={cn("h-4 w-4 opacity-50 transition-transform", open && "rotate-180")} />
    </button>
  )
}

export function SelectContent({ children }: SelectContentProps) {
  const { open, setOpen, triggerRect } = React.useContext(SelectContext)

  if (!open) return null

  return createPortal(
    <>
      <div 
        className="fixed inset-0 z-[9998]" 
        onClick={() => setOpen(false)} 
      />
      <div
        className="fixed z-[9999] min-w-[8rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
        style={triggerRect ? {
          left: triggerRect.left,
          bottom: window.innerHeight - triggerRect.top + 4,
          width: Math.max(triggerRect.width, 128),
          maxHeight: Math.max(triggerRect.top - 12, 48),
        } : undefined}
      >
        {children}
      </div>
    </>,
    document.body
  )
}

export function SelectItem({ value, children, className, ...props }: SelectItemProps) {
  const { value: selectedValue, onValueChange, setOpen } = React.useContext(SelectContext)

  return (
    <button
      type="button"
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 px-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        selectedValue === value && "bg-accent",
        className
      )}
      onClick={() => {
        onValueChange(value)
        setOpen(false)
      }}
      {...props}
    >
      {children}
    </button>
  )
}

export function SelectValue({ placeholder }: SelectValueProps) {
  const { value } = React.useContext(SelectContext)

  return <span>{value || placeholder}</span>
}
