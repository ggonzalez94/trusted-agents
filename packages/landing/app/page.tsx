import { Footer } from "@/components/sections/footer";
import { GetStarted } from "@/components/sections/get-started";
import { Hero } from "@/components/sections/hero";
import { HowItWorks } from "@/components/sections/how-it-works";
import { Problem } from "@/components/sections/problem";
import { TechStack } from "@/components/sections/tech-stack";
import { TrustModel } from "@/components/sections/trust-model";
import { UseCases } from "@/components/sections/use-cases";

export default function Page() {
	return (
		<main>
			<Hero />
			<Problem />
			<HowItWorks />
			<UseCases />
			<TrustModel />
			<TechStack />
			<GetStarted />
			<Footer />
		</main>
	);
}
