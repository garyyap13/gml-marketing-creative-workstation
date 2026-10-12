export type LabelKind =
  | 'product' | 'avatar' | 'angle' | 'funnel_stage' | 'initiative' | 'format'
  | 'narrative_style' | 'hook_type' | 'length' | 'aspect_ratio' | 'presenter'

export type LabelItem = { id: string; kind: LabelKind; name: string; media_kind: string | null }

// Each label list belongs to one team (D-13).
export const labelLists: Array<{ kind: LabelKind; name: string; team: 'marketing' | 'creative' }> = [
  { kind: 'product', name: 'Product', team: 'marketing' },
  { kind: 'avatar', name: 'Avatar', team: 'marketing' },
  { kind: 'angle', name: 'Angle', team: 'marketing' },
  { kind: 'funnel_stage', name: 'Funnel stage', team: 'marketing' },
  { kind: 'initiative', name: 'Initiative', team: 'marketing' },
  { kind: 'format', name: 'Format', team: 'marketing' },
  { kind: 'narrative_style', name: 'Narrative style', team: 'creative' },
  { kind: 'hook_type', name: 'Hook type', team: 'creative' },
  { kind: 'length', name: 'Length', team: 'creative' },
  { kind: 'aspect_ratio', name: 'Aspect ratio', team: 'creative' },
  { kind: 'presenter', name: 'Presenter', team: 'creative' },
]

export const labelName = (kind: LabelKind) => labelLists.find((list) => list.kind === kind)?.name ?? kind
