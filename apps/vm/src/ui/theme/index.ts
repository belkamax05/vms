import { createTheme } from '@/dev-tools/ui/theme';

/**
 * vm's sizes over the stock tables: porti's, since the one view is the same list beside a
 * detail pane, plus the one-line summary/prompt row drawn above the list.
 */
export const vmTheme = createTheme({
  sizes: {
    app: { minWidth: 72, minHeight: 18 },
  },
  chrome: {
    viewHeader: 1,
  },
});

export default vmTheme;
