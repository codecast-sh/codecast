"use client";

// Entry URL for /calls/<id>: same component as /calls — the TabContent router
// already maps both paths to it; this file only makes the deep link openable
// as a fresh browser navigation.
export { default } from "../page";
