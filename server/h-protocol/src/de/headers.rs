use std::net::{Ipv4Addr, Ipv6Addr};

use bytemuck::{Pod, Zeroable};

// ---------------------------------------------------------------------------
// Link-type constants
// ---------------------------------------------------------------------------
pub const LINKTYPE_NULL: u32 = 0;
pub const LINKTYPE_ETHERNET: u32 = 1;
pub const LINKTYPE_RAW: u32 = 101;
pub const LINKTYPE_LINUX_SLL: u32 = 113;
pub const LINKTYPE_LINUX_SLL2: u32 = 276;

// ---------------------------------------------------------------------------
// EtherType constants
// ---------------------------------------------------------------------------
pub const ETHERTYPE_IPV4: u16 = 0x0800;
pub const ETHERTYPE_IPV6: u16 = 0x86DD;
pub const ETHERTYPE_VLAN: u16 = 0x8100;
pub const ETHERTYPE_QINQ: u16 = 0x88A8;
pub const ETHERTYPE_MPLS: u16 = 0x8847;

// ---------------------------------------------------------------------------
// IP protocol constants
// ---------------------------------------------------------------------------
pub const IP_PROTO_TCP: u8 = 6;

// ---------------------------------------------------------------------------
// Address-family constants
// ---------------------------------------------------------------------------
pub const AF_INET: u32 = 2;
pub const AF_INET6_BSD: u32 = 30;
pub const AF_INET6_LINUX: u32 = 10;

// ---------------------------------------------------------------------------
// Ethernet (14 bytes)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct EthernetHeader {
    pub dst: [u8; 6],
    pub src: [u8; 6],
    pub ether_type: [u8; 2],
}

impl EthernetHeader {
    #[inline]
    pub fn ether_type(&self) -> u16 {
        u16::from_be_bytes(self.ether_type)
    }
}

// ---------------------------------------------------------------------------
// VLAN (4 bytes)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct VlanHeader {
    pub tci: [u8; 2],
    pub ether_type: [u8; 2],
}

impl VlanHeader {
    #[inline]
    pub fn ether_type(&self) -> u16 {
        u16::from_be_bytes(self.ether_type)
    }
}

// ---------------------------------------------------------------------------
// MPLS shim (4 bytes): 20-bit label, 3-bit TC, 1-bit S (bottom-of-stack), 8-bit TTL.
// Network byte order. We only need the S bit to know when to stop unwinding
// the label stack.
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MplsHeader {
    pub bytes: [u8; 4],
}

impl MplsHeader {
    /// True when this label is the bottom-of-stack (S bit set).
    ///
    /// In the 32-bit label entry, the S bit is the LSB of the third byte.
    #[inline]
    pub fn bottom_of_stack(&self) -> bool {
        self.bytes[2] & 0x01 != 0
    }
}

// ---------------------------------------------------------------------------
// Linux cooked capture v1 / SLL (16 bytes)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LinuxSllHeader {
    pub packet_type: [u8; 2],
    pub arphrd_type: [u8; 2],
    pub addr_len: [u8; 2],
    pub addr: [u8; 8],
    pub protocol: [u8; 2],
}

impl LinuxSllHeader {
    #[inline]
    pub fn protocol(&self) -> u16 {
        u16::from_be_bytes(self.protocol)
    }
}

// ---------------------------------------------------------------------------
// Linux cooked capture v2 / SLL2 (20 bytes)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LinuxSll2Header {
    pub protocol: [u8; 2],
    pub _reserved: [u8; 2],
    pub iface_index: [u8; 4],
    pub arphrd_type: [u8; 2],
    pub packet_type: u8,
    pub addr_len: u8,
    pub addr: [u8; 8],
}

impl LinuxSll2Header {
    #[inline]
    pub fn protocol(&self) -> u16 {
        u16::from_be_bytes(self.protocol)
    }
}

// ---------------------------------------------------------------------------
// BSD loopback / NULL (4 bytes) — address family in host byte order
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct NullHeader {
    pub af_family: [u8; 4],
}

impl NullHeader {
    #[inline]
    pub fn af_family(&self) -> u32 {
        u32::from_ne_bytes(self.af_family)
    }
}

// ---------------------------------------------------------------------------
// IPv4 (20 bytes minimum)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Ipv4Header {
    pub ver_ihl: u8,
    pub tos: u8,
    pub total_length: [u8; 2],
    pub identification: [u8; 2],
    pub flags_frag: [u8; 2],
    pub ttl: u8,
    pub protocol: u8,
    pub checksum: [u8; 2],
    pub src: [u8; 4],
    pub dst: [u8; 4],
}

impl Ipv4Header {
    /// Internet header length in bytes (IHL field × 4).
    #[inline]
    pub fn ihl(&self) -> usize {
        ((self.ver_ihl & 0x0F) as usize) * 4
    }

    #[inline]
    pub fn total_length(&self) -> u16 {
        u16::from_be_bytes(self.total_length)
    }

    #[inline]
    pub fn protocol(&self) -> u8 {
        self.protocol
    }

    #[inline]
    pub fn src_ip(&self) -> Ipv4Addr {
        Ipv4Addr::from(self.src)
    }

    #[inline]
    pub fn dst_ip(&self) -> Ipv4Addr {
        Ipv4Addr::from(self.dst)
    }
}

// ---------------------------------------------------------------------------
// IPv6 (40 bytes)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Ipv6Header {
    pub ver_tc_fl: [u8; 4],
    pub payload_length: [u8; 2],
    pub next_header: u8,
    pub hop_limit: u8,
    pub src: [u8; 16],
    pub dst: [u8; 16],
}

impl Ipv6Header {
    #[inline]
    pub fn payload_length(&self) -> u16 {
        u16::from_be_bytes(self.payload_length)
    }

    #[inline]
    pub fn next_header(&self) -> u8 {
        self.next_header
    }

    #[inline]
    pub fn src_ip(&self) -> Ipv6Addr {
        Ipv6Addr::from(self.src)
    }

    #[inline]
    pub fn dst_ip(&self) -> Ipv6Addr {
        Ipv6Addr::from(self.dst)
    }
}

// ---------------------------------------------------------------------------
// TCP (20 bytes minimum)
// ---------------------------------------------------------------------------
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct TcpHeader {
    pub src_port: [u8; 2],
    pub dst_port: [u8; 2],
    pub seq: [u8; 4],
    pub ack: [u8; 4],
    pub data_offset_flags: [u8; 2],
    pub window: [u8; 2],
    pub checksum: [u8; 2],
    pub urgent: [u8; 2],
}

impl TcpHeader {
    #[inline]
    pub fn src_port(&self) -> u16 {
        u16::from_be_bytes(self.src_port)
    }

    #[inline]
    pub fn dst_port(&self) -> u16 {
        u16::from_be_bytes(self.dst_port)
    }

    #[inline]
    pub fn seq(&self) -> u32 {
        u32::from_be_bytes(self.seq)
    }

    #[inline]
    pub fn ack(&self) -> u32 {
        u32::from_be_bytes(self.ack)
    }

    /// Data offset (TCP header length) in bytes.
    #[inline]
    pub fn data_offset(&self) -> usize {
        ((self.data_offset_flags[0] >> 4) as usize) * 4
    }

    /// Flags byte (lower byte of the data_offset_flags field).
    #[inline]
    pub fn flags(&self) -> u8 {
        self.data_offset_flags[1]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    /// Cast a sized byte buffer to a `Pod` header. Mirrors the `PacketBuf::peek`
    /// / `consume` idiom (`bytemuck::from_bytes`) used by the L2/L3/L4 decoders.
    fn hdr<H: Pod + Copy>(bytes: &[u8]) -> H {
        assert_eq!(bytes.len(), std::mem::size_of::<H>(), "buffer size mismatch");
        *bytemuck::from_bytes::<H>(bytes)
    }

    #[test]
    fn ethernet_ether_type_is_big_endian() {
        // src/dst MACs are 6 bytes each; ethertype 0x0800 (IPv4) in big-endian.
        let mut b = [0u8; 14];
        b[12] = 0x08;
        b[13] = 0x00;
        let h = hdr::<EthernetHeader>(&b);
        assert_eq!(h.ether_type(), ETHERTYPE_IPV4);
        // 0x86DD → IPv6.
        b[12] = 0x86;
        b[13] = 0xDD;
        assert_eq!(hdr::<EthernetHeader>(&b).ether_type(), ETHERTYPE_IPV6);
    }

    #[test]
    fn vlan_ether_type_is_big_endian() {
        let mut b = [0u8; 4];
        b[2] = 0x81;
        b[3] = 0x00;
        assert_eq!(hdr::<VlanHeader>(&b).ether_type(), ETHERTYPE_VLAN);
    }

    #[test]
    fn linux_sll_protocol_is_big_endian() {
        let mut b = [0u8; 16];
        b[14] = 0x08;
        b[15] = 0x00;
        assert_eq!(hdr::<LinuxSllHeader>(&b).protocol(), ETHERTYPE_IPV4);
    }

    #[test]
    fn linux_sll2_protocol_is_big_endian() {
        let mut b = [0u8; 20];
        b[0] = 0x86;
        b[1] = 0xDD;
        assert_eq!(hdr::<LinuxSll2Header>(&b).protocol(), ETHERTYPE_IPV6);
    }

    #[test]
    fn null_header_af_family_is_native_endian() {
        // AF_INET = 2 in host byte order (the `from_ne_bytes` accessor).
        let b: [u8; 4] = (AF_INET as u32).to_ne_bytes();
        assert_eq!(hdr::<NullHeader>(&b).af_family(), AF_INET);
    }

    #[test]
    fn mpls_bottom_of_stack_detects_s_bit() {
        // S bit is the LSB of the third byte.
        let mut b = [0u8; 4];
        // bottom-of-stack clear
        assert!(!hdr::<MplsHeader>(&b).bottom_of_stack());
        // set the S bit
        b[2] = 0x01;
        assert!(hdr::<MplsHeader>(&b).bottom_of_stack());
        // other bits in byte 2 do not flip the S bit
        b[2] = 0xFE;
        assert!(!hdr::<MplsHeader>(&b).bottom_of_stack());
        b[2] = 0xFF;
        assert!(hdr::<MplsHeader>(&b).bottom_of_stack());
    }

    #[test]
    fn ipv4_accessors() {
        // ver_ihl = 0x45 (version 4, IHL 5 → 20 bytes), proto TCP (6),
        // total_length = 0x0040 (big-endian), src/dst 10.0.0.1 / 10.0.0.2.
        let mut b = [0u8; 20];
        b[0] = 0x45; // ver=4, ihl=5
        b[9] = IP_PROTO_TCP;
        b[2] = 0x00;
        b[3] = 0x40; // total_length = 64
        b[12] = 10;
        b[13] = 0;
        b[14] = 0;
        b[15] = 1;
        b[16] = 10;
        b[17] = 0;
        b[18] = 0;
        b[19] = 2;
        let h = hdr::<Ipv4Header>(&b);
        assert_eq!(h.ihl(), 20);
        assert_eq!(h.total_length(), 64);
        assert_eq!(h.protocol(), IP_PROTO_TCP);
        assert_eq!(h.src_ip(), Ipv4Addr::new(10, 0, 0, 1));
        assert_eq!(h.dst_ip(), Ipv4Addr::new(10, 0, 0, 2));

        // IHL with options (IHL=6 → 24 bytes) and a non-TCP protocol (17=UDP).
        let mut b2 = b;
        b2[0] = 0x46; // ver=4, ihl=6
        b2[9] = 17;
        let h2 = hdr::<Ipv4Header>(&b2);
        assert_eq!(h2.ihl(), 24);
        assert_eq!(h2.protocol(), 17);
    }

    #[test]
    fn ipv6_accessors() {
        let mut b = [0u8; 40];
        // payload_length = 0x0100 (256) big-endian, next_header = 6 (TCP).
        b[4] = 0x01;
        b[5] = 0x00;
        b[6] = IP_PROTO_TCP;
        // src = ::1 (src[15] is the last byte of the 16-byte src field, at
        // buffer index 8+15=23), dst = ::2 (dst[15] at index 24+15=39).
        b[23] = 1;
        b[39] = 2;
        let h = hdr::<Ipv6Header>(&b);
        assert_eq!(h.payload_length(), 256);
        assert_eq!(h.next_header(), IP_PROTO_TCP);
        assert_eq!(h.src_ip(), Ipv6Addr::LOCALHOST);
        assert_eq!(h.dst_ip(), Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 2));
    }

    #[test]
    fn tcp_accessors() {
        // src_port=0x1234, dst_port=0x0050 (80), seq=0x00000007,
        // ack=0x00000008, data_offset=5 (→20B), flags=0x18 (PSH|ACK).
        let mut b = [0u8; 20];
        b[0] = 0x12;
        b[1] = 0x34; // src_port
        b[2] = 0x00;
        b[3] = 0x50; // dst_port = 80
        b[4] = 0x00;
        b[5] = 0x00;
        b[6] = 0x00;
        b[7] = 0x07; // seq = 7
        b[8] = 0x00;
        b[9] = 0x00;
        b[10] = 0x00;
        b[11] = 0x08; // ack = 8
        b[12] = 0x50; // data offset = 5 (high nibble), reserved low
        b[13] = 0x18; // flags = PSH|ACK
        let h = hdr::<TcpHeader>(&b);
        assert_eq!(h.src_port(), 0x1234);
        assert_eq!(h.dst_port(), 80);
        assert_eq!(h.seq(), 7);
        assert_eq!(h.ack(), 8);
        assert_eq!(h.data_offset(), 20);
        assert_eq!(h.flags(), 0x18);

        // Data offset with options: high nibble = 8 → 32-byte header.
        let mut b2 = b;
        b2[12] = 0x80;
        let h2 = hdr::<TcpHeader>(&b2);
        assert_eq!(h2.data_offset(), 32);
        assert_eq!(h2.flags(), 0x18); // flags byte is unchanged
    }
}
