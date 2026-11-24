// Adding or editing an address (components/address-form.tsx) in a bottom sheet, with "Use my location".
// Placeholder: the account module replaces the body; the signature stays.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';

/// Opens the address form; returns the saved address (POST /api/addresses or PUT /api/addresses/{id}), or null.
Future<Address?> showAddressSheet(BuildContext context, WidgetRef ref, {Address? initial}) async => null;
