export function getTabIdsForGrouping(
  trackedTabIds: number[],
  requestedTabIds: number[],
  existingGroupId?: number,
): number[] {
  const requested = uniqueTabIds(requestedTabIds);
  if (existingGroupId !== undefined) {
    return requested;
  }

  const firstGroup = uniqueTabIds([...trackedTabIds, ...requested]);
  return firstGroup.length > 1 ? firstGroup : [];
}

function uniqueTabIds(tabIds: number[]): number[] {
  return [...new Set(tabIds.filter((tabId) => Number.isInteger(tabId) && tabId >= 0))];
}