import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { call, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion } from './support'

// Subtitles as a Windows editing tool exports them: a byte-order mark, CRLF line endings, a line break inside a
// cue, an italic tag, a typo to fix, and a last cue that runs 40 ms past the end Drive measured.
const srt = '\uFEFF' + `1
00:00:00,000 --> 00:00:02,500
Only five minutes
to get ready?

2
00:00:08,000 --> 00:00:12,000
Here's the step I keep in my evryday routine.

3
00:00:25,500 --> 00:00:30,040
<i>Message us to find out more.</i>
`.replaceAll('\n', '\r\n')

// An untidy export: no milliseconds, no blank line between cues, and an escaped quotation mark.
const untidySrt = `1
00:00:00 --> 00:00:03
Only five minutes?
2
00:00:03 --> 00:00:05
&quot;Really?&quot;
`

const vtt = `WEBVTT

NOTE Exported from the editing tool

00:00.000 --> 00:03.000 align:start
<v Presenter>Only five minutes?</v>

00:02.000 --> 00:04.000
<v Friend>Really?
`

async function videoVersionFor(creativeName: string) {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', creativeName)
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  return { meiEmail, junEmail, junApi, ...(await submittedVideoVersion(junApi, creativeId)) }
}

async function fillSection(page: Page, number: number, fields: { type: string; detail?: string; start: string; end: string; onScreen: string }) {
  const section = page.getByRole('group', { name: `Section ${number}` })
  await section.getByLabel('Type').selectOption({ label: fields.type })
  if (fields.detail) await section.getByLabel('Detail').selectOption({ label: fields.detail })
  await section.getByLabel('Start').fill(fields.start)
  await section.getByLabel('End').fill(fields.end)
  await section.getByLabel('On-screen text').fill(fields.onScreen)
}

test('the Creative Team imports the editor\'s subtitles as a draft transcript, then marks Hook, Body and CTA with on-screen text', async ({ browser }) => {
  const { junEmail, variantCode, reviewId } = await videoVersionFor('Jun')

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/reviews/${reviewId}`)
  await expect(jun.getByRole('region', { name: 'Content timeline' })).toContainText('No transcript or sections yet')
  await jun.getByRole('link', { name: 'Edit transcript and sections' }).click()
  await expect(jun.getByRole('heading', { name: `${variantCode} · Version 1` })).toBeVisible()

  const transcript = jun.getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('Not transcribed yet')).toBeVisible()
  await transcript.getByLabel('Import subtitles (SRT or WebVTT)').setInputFiles({ name: `${variantCode}_v1.srt`, mimeType: 'application/x-subrip', buffer: Buffer.from(srt) })
  await expect(transcript.getByText(`Imported 3 cues from ${variantCode}_v1.srt`)).toBeVisible()
  const cues = transcript.getByRole('group', { name: /^Cue \d+$/ })
  await expect(cues).toHaveCount(3)
  await expect(cues.nth(0).getByLabel('Words')).toHaveValue('Only five minutes to get ready?')
  await expect(cues.nth(0).getByLabel('End')).toHaveValue('00:02.5')
  await expect(cues.nth(2).getByLabel('Words')).toHaveValue('Message us to find out more.')
  await expect(cues.nth(2).getByLabel('End')).toHaveValue('00:30')
  await expect(transcript.getByText('1 cue ending just after the video now ends with it')).toBeVisible()
  await cues.nth(1).getByLabel('Words').fill("Here's the step I keep in my everyday routine.")
  await jun.getByRole('button', { name: 'Save revision 1' }).click()
  await expect(jun.getByText('Saved revision 1')).toBeVisible()
  await expect(transcript.getByText('Draft transcript')).toBeVisible()

  const sections = jun.getByRole('region', { name: 'Content sections' })
  await expect(sections.getByText('No sections marked yet')).toBeVisible()
  for (let i = 0; i < 3; i++) await sections.getByRole('button', { name: 'Add section' }).click()
  await fillSection(jun, 1, { type: 'Hook', start: '0:00', end: '0:03', onScreen: 'Your morning, simplified.' })
  await fillSection(jun, 2, { type: 'Body', detail: 'Demo', start: '0:02', end: '0:25', onScreen: 'One everyday step.' })
  await fillSection(jun, 3, { type: 'CTA', detail: 'Offer', start: '0:25', end: '0:30', onScreen: 'Ask us about your routine.' })
  await jun.getByRole('button', { name: 'Save revision 2' }).click()
  await expect(jun.getByRole('alert')).toContainText('Section 2 overlaps another section')
  await expect(jun.getByRole('group', { name: 'Section 2' }).getByLabel('Start')).toBeFocused()
  await jun.getByRole('group', { name: 'Section 2' }).getByLabel('Start').fill('0:03')
  await jun.getByRole('button', { name: 'Save revision 2' }).click()
  await expect(jun.getByText('Saved revision 2')).toBeVisible()

  await jun.reload()
  await expect(jun.getByText('Revision 2 · Jun')).toBeVisible()
  await expect(jun.getByRole('group', { name: /^Section \d+$/ })).toHaveCount(3)
  await expect(jun.getByRole('group', { name: 'Section 3' }).getByLabel('On-screen text')).toHaveValue('Ask us about your routine.')
  await expect(jun.getByRole('group', { name: 'Cue 2' }).getByLabel('Words')).toHaveValue("Here's the step I keep in my everyday routine.")
})

test('a WebVTT export keeps its speakers, an untidy or Windows-1252 SRT still imports, and a file without subtitles is refused', async ({ browser }) => {
  const { junEmail, versionId } = await videoVersionFor('Jun')

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/versions/${versionId}/content`)
  const transcript = jun.getByRole('region', { name: 'Transcript' })
  const importer = transcript.getByLabel('Import subtitles (SRT or WebVTT)')
  await importer.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember to export the captions') })
  await expect(transcript.getByRole('alert')).toContainText('No subtitles found in notes.txt')
  await importer.setInputFiles({ name: 'morning.vtt', mimeType: 'text/vtt', buffer: Buffer.from(vtt) })
  const cues = transcript.getByRole('group', { name: /^Cue \d+$/ })
  await expect(cues).toHaveCount(2)
  await expect(cues.nth(0).getByLabel('Speaker')).toHaveValue('Presenter')
  await expect(cues.nth(0).getByLabel('Words')).toHaveValue('Only five minutes?')
  await expect(cues.nth(1).getByLabel('Speaker')).toHaveValue('Friend')
  await expect(cues.nth(1).getByLabel('Start')).toHaveValue('00:02')
  await jun.getByRole('button', { name: 'Save revision 1' }).click()
  await expect(jun.getByText('Saved revision 1')).toBeVisible()

  await importer.setInputFiles({ name: 'untidy.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(untidySrt) })
  await expect(cues).toHaveCount(2)
  await expect(cues.nth(0).getByLabel('Words')).toHaveValue('Only five minutes?')
  await expect(cues.nth(1).getByLabel('Words')).toHaveValue('"Really?"')
  await expect(cues.nth(1).getByLabel('Start')).toHaveValue('00:03')

  // Older Windows editing tools save Windows-1252 rather than UTF-8: é, an en dash and curly quotes are single bytes.
  const windows1252 = Buffer.concat([
    Buffer.from('1\r\n00:00:00,000 --> 00:00:02,000\r\nCaf'), Buffer.from([0xe9, 0x20, 0x96, 0x20, 0x93]), Buffer.from('ready'), Buffer.from([0x94, 0x0d, 0x0a]),
  ])
  await importer.setInputFiles({ name: 'cafe.srt', mimeType: 'application/x-subrip', buffer: windows1252 })
  await expect(cues).toHaveCount(1)
  await expect(cues.nth(0).getByLabel('Words')).toHaveValue('Café – “ready”')
  await expect(transcript.getByText(/read as Windows-1252/)).toBeVisible()

  // A UTF-8 file with one stray bad byte keeps its accents; only that byte is lost.
  const strayByte = Buffer.concat([Buffer.from('1\r\n00:00:00,000 --> 00:00:02,000\r\nSelamat pagi, café'), Buffer.from([0xff]), Buffer.from('\r\n')])
  await importer.setInputFiles({ name: 'pagi.srt', mimeType: 'application/x-subrip', buffer: strayByte })
  await expect(cues.nth(0).getByLabel('Words')).toHaveValue('Selamat pagi, café\ufffd')
  await expect(transcript.getByText(/read as Windows-1252/)).toHaveCount(0)
})

test('when someone saves a newer revision first, the editor can keep your changes and save on top', async ({ browser }) => {
  const { junEmail, junApi, versionId } = await videoVersionFor('Jun')
  const fileId = (await junApi.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()).data?.file_id
  const annotate = (prior: string | null, text: string) => call(junApi, 'save_video_annotations', {
    p_version_id: versionId, p_file_id: fileId, p_expected_prior_revision_id: prior, p_idempotency_key: randomUUID(),
    p_annotations: { language: 'en', source: 'manual', transcript_state: 'draft', section_state: 'not_started', sections: [],
      cues: [{ start_ms: 0, end_ms: 2500, text, speaker: 'Presenter' }] },
  })
  const first = await annotate(null, 'Only five minutes?')

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/versions/${versionId}/content`)
  await expect(jun.getByRole('group', { name: 'Cue 1' }).getByLabel('Words')).toHaveValue('Only five minutes?')
  await annotate(first.id, 'Only five minutes, really?') // saved from another tab meanwhile
  await jun.getByRole('group', { name: 'Cue 1' }).getByLabel('Speaker').fill('Aina')
  await jun.getByRole('button', { name: 'Save revision 2' }).click()
  await expect(jun.getByRole('alert')).toContainText('Revision 2 was saved while you were editing')
  await jun.getByRole('button', { name: 'Keep my changes and save as revision 3' }).click()
  await expect(jun.getByText('Saved revision 3')).toBeVisible()

  await jun.reload()
  await expect(jun.getByText(/^Revision 3 · /)).toBeVisible()
  await expect(jun.getByRole('group', { name: 'Cue 1' }).getByLabel('Speaker')).toHaveValue('Aina')
})

test('on the Review, picking a section shows its spoken words and on-screen text', async ({ browser }) => {
  const { meiEmail, junApi, versionId, reviewId } = await videoVersionFor('Jun')
  const versionFile = await junApi.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()
  await call(junApi, 'save_video_annotations', {
    p_version_id: versionId,
    p_file_id: versionFile.data?.file_id,
    p_expected_prior_revision_id: null,
    p_annotations: {
      language: 'en',
      source: 'manual',
      transcript_state: 'reviewed',
      section_state: 'draft',
      cues: [
        { start_ms: 0, end_ms: 2500, text: 'Only five minutes to get ready?', speaker: 'Presenter' },
        { start_ms: 8000, end_ms: 12000, text: "Here's the step I keep in my everyday routine.", speaker: 'Presenter' },
        { start_ms: 25500, end_ms: 29500, text: 'Message us to find out more.', speaker: 'Presenter' },
      ],
      sections: [
        { type: 'hook', detail: null, start_ms: 0, end_ms: 3000, on_screen_text: 'Your morning, simplified.' },
        { type: 'body', detail: 'problem', start_ms: 3000, end_ms: 8000, on_screen_text: 'Too many steps?' },
        { type: 'body', detail: 'demo', start_ms: 8000, end_ms: 25000, on_screen_text: 'One everyday step.' },
        { type: 'cta', detail: 'offer', start_ms: 25000, end_ms: 30000, on_screen_text: 'Ask us about your routine.' },
      ],
    },
    p_idempotency_key: randomUUID(),
  })

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/reviews/${reviewId}`)
  const timeline = mei.getByRole('region', { name: 'Content timeline' })
  await expect(timeline.getByRole('button', { name: /^(Hook|Problem|Demo|CTA)\b/ })).toHaveCount(4)
  await expect(timeline.getByRole('button', { name: /^Hook/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(timeline.getByRole('heading', { name: 'Hook · 00:00–00:03' })).toBeVisible()
  await expect(timeline).toContainText('“Only five minutes to get ready?”')
  await expect(timeline).toContainText('Your morning, simplified.')

  await timeline.getByRole('button', { name: /^Demo/ }).click()
  await expect(timeline.getByRole('heading', { name: 'Body · Demo · 00:08–00:25' })).toBeVisible()
  await expect(timeline).toContainText("“Here's the step I keep in my everyday routine.”")
  await expect(timeline).toContainText('One everyday step.')

  await timeline.getByRole('button', { name: /^Problem/ }).click()
  await expect(timeline).toContainText('No speech in this section')
  await expect(timeline).toContainText('Too many steps?')
  await expect(timeline).toContainText('Reviewed transcript')
  await expect(mei.getByRole('link', { name: 'Edit transcript and sections' })).toHaveCount(0)

  await mei.goto(`/versions/${versionId}/content`)
  await expect(mei.getByText('Only the Creative Team edits the transcript and sections.')).toBeVisible()
  await expect(mei.getByRole('group', { name: 'Section 4' }).getByLabel('On-screen text')).toBeDisabled()
  await expect(mei.getByRole('button', { name: /^Save revision/ })).toHaveCount(0)
})
