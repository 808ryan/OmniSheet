import { useCallback, useRef, useState } from 'react'
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

export interface QuickEntryScrollMetrics {
  canScroll: boolean
  thumbTopPct: number
  thumbHeightPct: number
}

interface QuickEntryScrollIndicatorProps {
  scrollRef: RefObject<HTMLDivElement | null>
  metrics: QuickEntryScrollMetrics
}

interface ScrollDragState {
  pointerId: number
  thumbGrabOffsetPx: number
}

export function QuickEntryScrollIndicator({
  scrollRef,
  metrics,
}: QuickEntryScrollIndicatorProps) {
  const dragStateRef = useRef<ScrollDragState | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const scrollToClientY = useCallback((
    track: HTMLElement,
    clientY: number,
    thumbGrabOffsetPx: number,
  ) => {
    const scrollNode = scrollRef.current
    if (!scrollNode) {
      return
    }

    const maxScrollTop = Math.max(scrollNode.scrollHeight - scrollNode.clientHeight, 0)
    if (maxScrollTop <= 0) {
      return
    }

    const trackRect = track.getBoundingClientRect()
    const trackHeight = Math.max(trackRect.height, 0)
    const thumbHeightPx = Math.min(
      trackHeight,
      Math.max((metrics.thumbHeightPct / 100) * trackHeight, 1),
    )
    const maxThumbTopPx = Math.max(trackHeight - thumbHeightPx, 0)

    if (maxThumbTopPx <= 0) {
      scrollNode.scrollTop = 0
      return
    }

    const nextThumbTopPx = clamp(
      clientY - trackRect.top - thumbGrabOffsetPx,
      0,
      maxThumbTopPx,
    )

    scrollNode.scrollTop = (nextThumbTopPx / maxThumbTopPx) * maxScrollTop
  }, [metrics.thumbHeightPct, scrollRef])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    const track = event.currentTarget
    const trackRect = track.getBoundingClientRect()
    const trackHeight = Math.max(trackRect.height, 0)
    const thumbHeightPx = Math.min(
      trackHeight,
      Math.max((metrics.thumbHeightPct / 100) * trackHeight, 1),
    )
    const thumbTopPx = clamp(
      (metrics.thumbTopPct / 100) * trackHeight,
      0,
      Math.max(trackHeight - thumbHeightPx, 0),
    )
    const pointerTarget = event.target instanceof Node ? event.target : null
    const thumb = track.querySelector('.quick-add-scroll-indicator-thumb')
    const clickedThumb = Boolean(pointerTarget && thumb?.contains(pointerTarget))
    const thumbGrabOffsetPx = clickedThumb
      ? clamp(event.clientY - trackRect.top - thumbTopPx, 0, thumbHeightPx)
      : thumbHeightPx / 2

    event.preventDefault()
    event.stopPropagation()
    track.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      thumbGrabOffsetPx,
    }
    setIsDragging(true)
    scrollToClientY(track, event.clientY, thumbGrabOffsetPx)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    scrollToClientY(event.currentTarget, event.clientY, dragState.thumbGrabOffsetPx)
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    event.preventDefault()
    event.stopPropagation()
    dragStateRef.current = null
    setIsDragging(false)
  }

  if (!metrics.canScroll) {
    return null
  }

  return (
    <div
      className={`quick-add-scroll-indicator${isDragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={() => {
        dragStateRef.current = null
        setIsDragging(false)
      }}
      style={{
        '--quick-add-scroll-thumb-top': `${metrics.thumbTopPct}%`,
        '--quick-add-scroll-thumb-height': `${metrics.thumbHeightPct}%`,
      } as CSSProperties}
    >
      <span className="quick-add-scroll-indicator-thumb" />
    </div>
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
