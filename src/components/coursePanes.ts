/**
 * The course view's components, a chunk of their own: the editor (CodeMirror), the problem pane
 * (its widgets and figures) and the verdict pane. Loaded through `loadCoursePanes`, never imported
 * directly, so the problem list does not download them.
 */
export {default as ProblemPane} from './ProblemPane';
export {default as StepEditor} from './StepEditor';
export {SubmissionCode, default as VerdictPane} from './VerdictPane';
