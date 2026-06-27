import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export interface SegmentedControlOption<T extends string> {
  id: T
  label: ReactNode
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  className?: string
  mode?: 'tab' | 'toggle'
  onChange: (value: T) => void
  options: readonly SegmentedControlOption<T>[]
  value: T
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  className,
  mode = 'toggle',
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLSpanElement | null>(null)
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>())

  const updateIndicator = useCallback(() => {
    const root = rootRef.current
    const indicator = indicatorRef.current
    const activeButton = buttonRefs.current.get(value)

    if (!root || !indicator || !activeButton) {
      return
    }

    indicator.style.width = `${activeButton.offsetWidth}px`
    indicator.style.transform = `translate3d(${activeButton.offsetLeft}px, 0, 0)`
  }, [value])

  useLayoutEffect(() => {
    updateIndicator()

    const root = rootRef.current
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateIndicator)

    if (root && resizeObserver) {
      resizeObserver.observe(root)
      buttonRefs.current.forEach((button) => resizeObserver.observe(button))
    }

    window.addEventListener('resize', updateIndicator)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateIndicator)
    }
  }, [options.length, updateIndicator])

  const controlClassName = [
    'segmented-control',
    'segmented-control-sliding',
    className,
  ].filter(Boolean).join(' ')
  const isTabMode = mode === 'tab'

  return (
    <div
      ref={rootRef}
      className={controlClassName}
      role={isTabMode ? 'tablist' : 'group'}
      aria-label={ariaLabel}
    >
      <span ref={indicatorRef} className="segmented-control-indicator" aria-hidden="true" />
      {options.map((option) => {
        const isActive = option.id === value

        return (
          <button
            key={option.id}
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(option.id, node)
              } else {
                buttonRefs.current.delete(option.id)
              }
            }}
            type="button"
            role={isTabMode ? 'tab' : undefined}
            aria-selected={isTabMode ? isActive : undefined}
            aria-pressed={isTabMode ? undefined : isActive}
            className={isActive ? 'active' : ''}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
