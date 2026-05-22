import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import React from "react";

import { useLicense } from "@/contexts/LicenseContext";

export default function TabLayout() {
  const { isAdmin } = useLicense();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#0F1829",
          borderTopColor: "#1E2D45",
          borderTopWidth: 1,
          height: 58,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarActiveTintColor:   "#F59E0B",
        tabBarInactiveTintColor: "#475569",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Measure",
          tabBarIcon: ({ color, size }) => (
            <Feather name="edit-2" size={size - 2} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: "Saved Plots",
          tabBarIcon: ({ color, size }) => (
            <Feather name="bookmark" size={size - 2} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="admin"
        options={{
          title: "Admin",
          tabBarIcon: ({ color, size }) => (
            <Feather name="shield" size={size - 2} color={color} />
          ),
          // Hide tab from regular users — only visible in admin mode
          tabBarButton: isAdmin ? undefined : () => null,
          tabBarStyle: isAdmin ? undefined : { display: "none" },
        }}
      />
    </Tabs>
  );
}
