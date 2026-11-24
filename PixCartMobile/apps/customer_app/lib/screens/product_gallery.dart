// The product gallery on phones (components/product-gallery.tsx): swipe between photos, dots, pinch to
// zoom, and a tap opens the full-screen viewer (pinch-zoom, swipe, "2 / 5", close).

import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

class ProductGallery extends StatefulWidget {
  const ProductGallery({super.key, required this.images, required this.title, this.zoom = true, this.zoomLevel = 2.5});
  final List<String> images;
  final String title;
  final bool zoom;
  final double zoomLevel;

  @override
  State<ProductGallery> createState() => _ProductGalleryState();
}

class _ProductGalleryState extends State<ProductGallery> {
  final _pages = PageController();
  int _i = 0;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  void _open(int i) => Navigator.of(context).push(PageRouteBuilder(
        opaque: false,
        pageBuilder: (_, _, _) => FullScreenGallery(images: widget.images, title: widget.title, initial: i, maxScale: widget.zoomLevel * 2),
        transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
      ));

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final images = widget.images;
    if (images.isEmpty) {
      return AspectRatio(aspectRatio: 1, child: Container(color: t.page, alignment: Alignment.center, child: Text('No image', style: Tw.sm(color: t.inkFaint))));
    }
    return Column(children: [
      AspectRatio(
        aspectRatio: 1,
        child: Stack(children: [
          PageView.builder(
            controller: _pages,
            itemCount: images.length,
            onPageChanged: (i) => setState(() => _i = i),
            itemBuilder: (_, i) => GestureDetector(
              onTap: () => _open(i),
              child: Semantics(
                label: 'View photo ${i + 1} of ${images.length} full screen',
                button: true,
                child: InteractiveViewer(
                  maxScale: widget.zoom ? widget.zoomLevel : 1,
                  panEnabled: false,
                  child: ProductImage(src: images[i], alt: i == 0 ? widget.title : ''),
                ),
              ),
            ),
          ),
        ]),
      ),
      if (images.length > 1) ...[
        const SizedBox(height: 8),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          for (var i = 0; i < images.length; i++)
            AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              width: i == _i ? 16 : 6,
              height: 6,
              margin: const EdgeInsets.symmetric(horizontal: 3),
              decoration: BoxDecoration(color: i == _i ? t.primary : t.line, borderRadius: BorderRadius.circular(999)),
            ),
        ]),
      ],
    ]);
  }
}

/// Every photo full screen on black: swipe, pinch to zoom, close.
class FullScreenGallery extends StatefulWidget {
  const FullScreenGallery({super.key, required this.images, required this.title, this.initial = 0, this.maxScale = 5});
  final List<String> images;
  final String title;
  final int initial;
  final double maxScale;

  @override
  State<FullScreenGallery> createState() => _FullScreenGalleryState();
}

class _FullScreenGalleryState extends State<FullScreenGallery> {
  late final _pages = PageController(initialPage: widget.initial);
  late int _i = widget.initial;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final n = widget.images.length;
    return Material(
      color: Colors.black.withValues(alpha: 0.9),
      child: SafeArea(
        child: Stack(children: [
          PageView.builder(
            controller: _pages,
            itemCount: n,
            onPageChanged: (i) => setState(() => _i = i),
            itemBuilder: (_, i) => InteractiveViewer(
              maxScale: widget.maxScale,
              child: Center(child: Image.network(mediaUrl(widget.images[i]), fit: BoxFit.contain, semanticLabel: widget.title)),
            ),
          ),
          Positioned(
            right: 16,
            top: 16,
            child: Semantics(
              button: true,
              label: 'Close',
              child: GestureDetector(
                onTap: () => Navigator.of(context).pop(),
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.15), shape: BoxShape.circle),
                  child: const Icon(LucideIcons.x, size: 24, color: Colors.white),
                ),
              ),
            ),
          ),
          if (n > 1)
            Positioned(
              bottom: 16,
              left: 0,
              right: 0,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(999)),
                  child: Text('${_i + 1} / $n', style: Tw.sm(color: Colors.white)),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}
