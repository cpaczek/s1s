# Search interface patterns

This is a task interface for searching source code. Its visual decisions should
make the next action and the returned evidence easy to find while giving the
product a recognizable identity. The interface uses an editorial source-index
direction: ivory, dark ink, one warm accent, serif display type and monospaced
wayfinding. Local system fonts keep it offline and dependency-free.

## Patterns applied

- **One primary task.** Repository, question and Search stay together. The initial
  view does not download or expose the full tree. Results appear below the same
  query so users can refine it without losing context. [Carbon search guidance](https://carbondesignsystem.com/patterns/search-pattern/).
- **Progressive disclosure.** Five file results are visible first. Further rows,
  source evidence and search steps are available on request. The playground holds
  the full tree and trace. An explicit handoff restores the completed run rather
  than silently paying for another search. [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/).
- **Visible labels.** Repository and Question have persistent labels. Placeholder
  text is an example or hint, not the only explanation of the field. Keyboard,
  focus, error and disabled states remain functional. [GOV.UK text-input guidance](https://design-system.service.gov.uk/components/text-input/).
- **Consistent hierarchy.** A deliberate type scale, shared left edges, predictable
  control sizes and repeatable spacing support both the display headline and the
  working search controls. Repository descriptions are readable near the selector
  and in a numbered directory. Supporting navigation remains quieter than the
  user's query and results. [Linear's hierarchy work](https://linear.app/now/how-we-redesigned-the-linear-ui)
  and [GOV.UK type-scale guidance](https://design-system.service.gov.uk/styles/type-scale/).
- **Honest feedback.** Activity changes only when real SSE events arrive. File
  counts use unique reported paths; evidence checks do not imply every file is
  relevant. Cached and restored runs are labeled. There are no invented thinking
  steps, percent-complete estimates or fabricated file activity. [Carbon loading patterns](https://preview.carbondesignsystem.com/building-blocks/core/patterns/loading).

These are interaction and consistency references, not visual templates to copy.
The project uses its own typographic wordmark, local fonts, SVG/CSS controls
and source-specific output. No third-party logos, page assets or design-system
stylesheets are imported.

## Review states, not only the landing screenshot

Check the empty form, live stream, confident/partial/absent results, provider
warnings, cached playback, source preview, cancelled run and failed request.
Verify the simple interface and playground at phone, tablet and desktop widths,
including keyboard use and reduced motion. The browser smoke suite exercises
these states; a passing layout check is supplemented with screenshot inspection.

## Mobile activity and recorded playback

Submitting on mobile dismisses the input keyboard and brings the activity into
view. The form, suggestions and intro remain in place; live headings, file marks,
counts and recent paths have bounded space that remains after completion. A
short visual-viewport listener accounts for keyboard dismissal and stops on a
manual touch or wheel scroll.

Completed runs offer Replay steps, three reading paces, Pause/Resume and Next
step. Playback consumes the original ordered server events, keeps the answer
visible, and makes no API calls. Its label explicitly says recorded replay;
the pacing is for reading, not a claim about original execution timing. Changing
repositories, starting another search or leaving the page cancels playback.
