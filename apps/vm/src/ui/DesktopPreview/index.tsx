import { type DOMElement, Text } from 'ink';
import { useMemo, useRef } from 'react';

import {
  bestTechnique,
  drawImage,
  fitFootprint,
  graphicsSupport,
  type RasterTechnique,
  type Subject,
} from '@/dev-tools/terminal-canvas';
import Box from '@/dev-tools/ui/components/Box';
import GraphicsCanvas from '@/dev-tools/ui/components/GraphicsCanvas';
import useLoader from '@/dev-tools/ui/hooks/useLoader';
import useRasterOverlay from '@/dev-tools/ui/hooks/useRasterOverlay';
import { useColors } from '@/dev-tools/ui/providers/TuiThemeProvider';

import { cachedPreview, loadPreview, previewCredit } from '../../core/previews';

/** Its own overlay id: one preview is on screen at a time, replaced as the cursor moves. */
const OVERLAY_ID = 9101;

/**
 * What a desktop looks like, `cols` x `rows` cells: through the terminal's graphics protocol
 * (Kitty, Sixel, iTerm2 - the one terminal-canvas finds) when it has one, in text cells
 * (half-blocks, sextants) when it hasn't. The cached copy shows at once; the fresh one from the
 * project's site replaces it once fetched.
 */
export const DesktopPreview = ({
  id,
  label,
  source,
  cols,
  rows,
}: {
  id: string;
  label: string;
  source: string;
  cols: number;
  rows: number;
}) => {
  const colors = useColors();
  const ref = useRef<DOMElement>(null);
  const support = graphicsSupport();
  const technique = bestTechnique(support);
  const raster = technique.kind === 'raster' ? (technique as RasterTechnique) : undefined;
  const cached = useMemo(() => cachedPreview(id), [id]);
  const { data: fresh, isLoading } = useLoader(() => loadPreview(id, source), [id, source]);
  const image = fresh ?? cached;

  const subject = useMemo<Subject>(
    () => ({
      id: `desktop:${id}:${image ? `${image.width}x${image.height}` : 'none'}`,
      label,
      note: '',
      animated: false,
      draw: (surface) => {
        if (image) drawImage(surface, image);
      },
    }),
    [id, label, image],
  );
  // The image's room less the caption's line.
  const footprint = image ? fitFootprint(cols, rows - 1, image.width / image.height) : undefined;

  useRasterOverlay({
    technique: raster && image ? raster : undefined,
    subject,
    time: 0,
    animating: false,
    target: ref,
    cellWidth: support.cellWidth,
    cellHeight: support.cellHeight,
    imagesInCells: support.imagesInCells,
    imageId: OVERLAY_ID,
  });

  return (
    <Box width={cols} height={rows} flexDirection="column" flexShrink={0} alignItems="center">
      {image && footprint ? (
        <GraphicsCanvas
          ref={ref}
          technique={technique}
          subject={subject}
          time={0}
          cols={footprint.cols}
          rows={footprint.rows}
        />
      ) : (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text color={colors.muted}>{isLoading ? 'Loading preview…' : 'No preview'}</Text>
        </Box>
      )}
      <Text color={colors.muted} wrap="truncate">
        {`${label} · ${previewCredit(source)}${isLoading && cached ? ' · refreshing…' : ''}`}
      </Text>
    </Box>
  );
};

export default DesktopPreview;
