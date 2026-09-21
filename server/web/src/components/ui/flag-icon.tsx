export function FlagIcon({ countryCode, className }: { countryCode?: string; className?: string }) {
  if (!countryCode || countryCode.length !== 2) return null
  return (
    <span
      className={`fi fi-${countryCode.toLowerCase()} rounded-[2px] ${className ?? ''}`}
      aria-hidden="true"
    />
  )
}
