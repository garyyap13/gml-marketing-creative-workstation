import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'

export type TeamSettings = { time_zone: string; lock_version: number }

// The single settings row, with the team time zone that "today" follows for due dates and Verdict check dates (D-78).
export function useTeamSettings() {
  return useQuery({
    queryKey: ['team-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.schema('core').from('settings').select('time_zone, lock_version').single()
      if (error) throw error
      return data as TeamSettings
    },
  })
}

// A day as YYYY-MM-DD in a time zone.
export const dateIn = (timeZone: string, at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(at)

// The team's today, as the commands that check due and check dates see it; the browser's own date until the settings load.
export function useTeamToday(): string {
  const settings = useTeamSettings()
  return settings.data ? dateIn(settings.data.time_zone) : dateIn(Intl.DateTimeFormat().resolvedOptions().timeZone)
}
