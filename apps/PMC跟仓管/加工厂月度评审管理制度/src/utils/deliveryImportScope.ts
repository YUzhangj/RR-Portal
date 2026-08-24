import type { Factory } from '../types/factory'
import { regionOf, type Craft, type Region } from '../constants/roles'

export function deliveryImportFactoryMap(
  factories: Factory[],
  craft: Craft,
  region: Region | null,
): Record<string, string> {
  return Object.fromEntries(
    factories
      .filter((factory) => factory.craft === craft)
      .filter((factory) => !region || regionOf(factory) === region)
      .map((factory) => [factory.name, factory.id]),
  )
}

export function deliveryScopeFactoryIds(
  factories: Factory[],
  craft: Craft,
  region: Region,
): Set<string> {
  return new Set(factories
    .filter((factory) => factory.craft === craft && regionOf(factory) === region)
    .map((factory) => factory.id))
}
