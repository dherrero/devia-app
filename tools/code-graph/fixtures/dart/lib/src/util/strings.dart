String slugify(String input) => collapseDashes(input.toLowerCase().replaceAll(RegExp('[^a-z0-9]+'), '-'));

String collapseDashes(String input) => input.replaceAll(RegExp('-+'), '-');

String normaliseEmail(String email) => email.trim().toLowerCase();
