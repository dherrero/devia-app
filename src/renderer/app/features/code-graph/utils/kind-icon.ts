import {
  type LucideIcon,
  LucideBox, LucideBraces, LucideCircleDot, LucideCode, LucideComponent, LucideFileCode, LucideFolder, LucideHash, LucideRoute,
  LucideShapes, LucideSquareFunction, LucideType, LucideVariable,
} from '@lucide/angular';

const ICONS: Partial<Record<string, LucideIcon>> = {
  dir: LucideFolder,
  file: LucideFileCode,
  module: LucideBox,
  namespace: LucideBox,
  class: LucideShapes,
  interface: LucideBraces,
  type_alias: LucideType,
  enum: LucideHash,
  enum_member: LucideHash,
  function: LucideSquareFunction,
  method: LucideSquareFunction,
  property: LucideVariable,
  field: LucideVariable,
  variable: LucideVariable,
  constant: LucideVariable,
  parameter: LucideVariable,
  import: LucideCode,
  export: LucideCode,
  component: LucideComponent,
  route: LucideRoute,
};

/** The icon that stands for a node kind in lists (search results, detail panel). */
export function kindIcon(kind: string): LucideIcon {
  return ICONS[kind] ?? LucideCircleDot;
}
