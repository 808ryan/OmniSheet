interface InterfaceIconProps {
  className?: string
}

export function SearchIcon({ className }: InterfaceIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6.6" cy="6.6" r="4.35" />
      <path d="m9.72 9.72 4.03 4.03" />
    </svg>
  )
}

export function TimerIcon({ className }: InterfaceIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 1.75h4" />
      <path d="M8 1.75v1.5" />
      <circle cx="8" cy="9" r="5.1" />
      <path d="M8 5.8V9l2.2 1.35" />
    </svg>
  )
}

export function TrashIcon({ className }: InterfaceIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 4.25h9" />
      <path d="M6.25 2.75h3.5" />
      <path d="M4.75 5.5v6.75h6.5V5.5" />
    </svg>
  )
}

export function StopIcon({ className }: InterfaceIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.25" />
    </svg>
  )
}

export function PlusIcon({ className }: InterfaceIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  )
}

export function ChevronDownIcon({ className }: InterfaceIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4.25 6.25 3.75 3.5 3.75-3.5" />
    </svg>
  )
}
