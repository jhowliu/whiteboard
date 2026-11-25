import type { ReactNode, SVGProps } from 'react'

// One authored icon family: 24 px grid, 1.75 px round strokes, drawn in currentColor.

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export const ChevronLeftIcon = () => (
  <Icon>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Icon>
)

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const MoreIcon = () => (
  <Icon fill="currentColor" stroke="none">
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </Icon>
)

export const UndoIcon = () => (
  <Icon>
    <path d="M9 14 4.5 9.5 9 5" />
    <path d="M4.5 9.5h10a5 5 0 0 1 0 10H11" />
  </Icon>
)

export const RedoIcon = () => (
  <Icon>
    <path d="m15 14 4.5-4.5L15 5" />
    <path d="M19.5 9.5h-10a5 5 0 0 0 0 10H13" />
  </Icon>
)

export const ImportIcon = () => (
  <Icon>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5" />
    <path d="M12 10.5v6m-2.5-2.5 2.5 2.5 2.5-2.5" />
  </Icon>
)

export const ExportIcon = () => (
  <Icon>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5" />
    <path d="M12 17v-6m-2.5 2.5L12 11l2.5 2.5" />
  </Icon>
)

export const PenIcon = () => (
  <Icon>
    <path d="M15.5 5.5a2.1 2.1 0 0 1 3 3L8.5 18.5 4.5 19.5l1-4z" />
    <path d="m14 7 3 3" />
  </Icon>
)

export const HighlighterIcon = () => (
  <Icon>
    <path d="m14.5 4.5 5 5-7 7-5-5z" />
    <path d="M7.5 11.5 6 16l2 2 4.5-1.5" />
    <path d="M6 18 4 20h4" />
  </Icon>
)

export const EraserIcon = () => (
  <Icon>
    <path d="M14 4.8a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L10.4 18.8H7.6l-3-3a2 2 0 0 1 0-2.8z" />
    <path d="m9.5 9.3 5.2 5.2" />
    <path d="M10.4 18.8h9" />
  </Icon>
)

export const FingerIcon = () => (
  <Icon>
    <path d="M9.5 12.5V5.25a1.75 1.75 0 0 1 3.5 0V11" />
    <path d="M13 10.25a1.75 1.75 0 0 1 3.5 0V12" />
    <path d="M16.5 11.25a1.75 1.75 0 0 1 3.5 0V15a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.7-2.3l-3-3.8a1.6 1.6 0 0 1 2.5-2L9.5 15" />
  </Icon>
)
