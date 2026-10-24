"""The five regions and the load targets, in one place.

The order of :data:`REGIONS` is the *interleave order* used by ``load_flights.py``.
Rows are generated day first, region second, so the write path stays sequential by
``departure_date`` (which is what the monthly partitions want) while every region
still receives exactly ``TARGETS["per_region_flights"]`` rows.

Nothing here hardcodes the airport or airline catalog. ``load_flights.py`` queries
``airports`` / ``airlines`` by region at startup, so adding an airport to the
database is enough for the next load to use it -- and the orphan checks in
``scripts/validate-data.js`` stay green without touching this file.
"""

from __future__ import annotations

REGIONS: tuple[str, ...] = (
    "SOUTH_ASIA",
    "MIDDLE_EAST",
    "EUROPE",
    "NORTH_AMERICA",
    "EAST_ASIA",
)

REGION_NAMES = {
    "SOUTH_ASIA": "South Asia",
    "MIDDLE_EAST": "Middle East",
    "EUROPE": "Europe",
    "NORTH_AMERICA": "North America",
    "EAST_ASIA": "East Asia",
}

#: Hub used when a flight leaves its own region. Every hub is an airport whose
#: ``region`` column is the region it represents (migration 012).
HUBS = {
    "SOUTH_ASIA": "ISB",
    "MIDDLE_EAST": "DXB",
    "EUROPE": "LHR",
    "NORTH_AMERICA": "JFK",
    "EAST_ASIA": "SIN",
}

#: Dialling code used to build a plausible, region-specific phone number.
DIAL_CODES = {
    "SOUTH_ASIA": "92",
    "MIDDLE_EAST": "971",
    "EUROPE": "44",
    "NORTH_AMERICA": "1",
    "EAST_ASIA": "65",
}

TARGETS = {
    "flights": 50_000_000,
    "users": 100_000,
    "per_region_flights": 10_000_000,
    "per_region_users": 20_000,
}

#: Mirrors ``src/services/pricingService.js``. A booking, a search row and a seat map
#: must quote the same number for a seat, so the multiplier lives in both places on
#: purpose; changing it is a one-line change on each side.
CABIN_MULTIPLIER = {
    "ECONOMY": 1.0,
    "PREMIUM_ECONOMY": 1.6,
    "BUSINESS": 3.2,
    "FIRST": 5.5,
}

# Aircraft pools. Capacities are read from ``seat_map_templates`` at load time, never
# guessed here -- the seed maps A320 12B+162Y, A321 16B+192Y, B737 12B+174Y,
# B777 8F+28B+216Y, B787 20B+210Y, ATR72 72Y.
SHORT_HAUL_AIRCRAFT = ("A320", "A321", "B737")
LONG_HAUL_AIRCRAFT = ("B777", "B787")

# Names have no bearing on correctness; they exist so a loaded row looks like a person
# in the API and in reports. Indexing them by the deterministic row number keeps the
# whole load reproducible.
FIRST_NAMES = (
    "Ayesha", "Bilal", "Chen", "Dania", "Emre", "Farah", "Hassan", "Ines",
    "Joon", "Kavya", "Laila", "Mateo", "Nadia", "Omar", "Priya", "Rami",
    "Sara", "Tariq", "Yuki", "Zara",
)

LAST_NAMES = (
    "Ahmed", "Bhatti", "Chen", "Dubois", "Ekim", "Farooq", "Garcia", "Huang",
    "Iqbal", "Jensen", "Khan", "Lee", "Malik", "Nakamura", "Okafor", "Park",
    "Qureshi", "Rahman", "Singh", "Tan",
)


def region_index(region: str) -> int:
    """Position of ``region`` in the canonical interleave order."""
    return REGIONS.index(region)
